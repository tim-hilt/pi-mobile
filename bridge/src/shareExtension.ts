import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSocketPath } from "./link.js";
import { LinkClient } from "./linkClient.js";
import { pairingQr } from "./pairing.js";
import { PiShare, totalCost, type PiEvent } from "./piShare.js";
import { PrintRun } from "./printRun.js";
import {
  DISABLE_FOCUS_REPORTING,
  ENABLE_FOCUS_REPORTING,
  focusChange,
} from "./terminalFocus.js";

/**
 * Pi extension that shares every interactive pi session with the bridge, so
 * the app can list and join it, and reports the settled runs of print-mode
 * pi. The first interactive pi to find no bridge starts one (detached,
 * outliving it); see README. `/show-bridge-qr` shows the QR code
 * the app scans to log in.
 */
export default function share(pi: ExtensionAPI) {
  let current: PiShare | undefined;
  /** Set in print mode only, with the link its runs are reported on. */
  let print: { run: PrintRun; link: LinkClient } | undefined;
  let stopFocusInput: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) {
      // Print and JSON runs are one-shot: not shared, but their settled runs are reported.
      // They never start the bridge; without one, nothing is sent.
      const link = linkClient(() => {});
      const run = new PrintRun(
        {
          sessionId: () => ctx.sessionManager.getSessionId(),
          sessionName: () => pi.getSessionName(),
          cwd: ctx.cwd,
          contextUsage: () => ctx.getContextUsage(),
          cost: () => totalCost(ctx.sessionManager.getEntries()),
        },
        (record) => link.send(record)
      );
      print = { run, link };
      return;
    }
    const link = linkClient();
    current = new PiShare(host(pi, ctx), (record) => link.send(record));
    link.attach(current);
    if (ctx.mode !== "tui") return;
    // Pi's fullscreen TUI consumes the focus codes before extensions see them: focus stays unknown there.
    process.stdout.write(ENABLE_FOCUS_REPORTING);
    stopFocusInput = ctx.ui.onTerminalInput((data) => {
      const focused = focusChange(data);
      if (focused === undefined) return;
      link.setFocus(focused);
      return { consume: true };
    });
  });
  pi.on("session_info_changed", () => current?.infoChanged());
  pi.on("session_shutdown", async (event) => {
    if (print) {
      const { link } = print;
      print = undefined;
      // Pi exits next: give the report time to leave, but never hold the script up.
      await link.flush();
      return closeLink();
    }
    const reporting = stopFocusInput !== undefined;
    stopFocusInput?.();
    stopFocusInput = undefined;
    if (!current) return;
    const link = linkClient();
    link.detach(current);
    current = undefined;
    // Otherwise pi is replacing the session and the next one re-announces on the same link.
    if (event.reason === "quit") {
      // Replacement keeps reporting on: the next session listens again.
      if (reporting) process.stdout.write(DISABLE_FOCUS_REPORTING);
      closeLink();
    }
  });
  pi.registerCommand("show-bridge-qr", {
    description: "Show the QR code that logs Pi Mobile in to the bridge",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("show-bridge-qr requires interactive mode", "error");
        return;
      }
      let url: string;
      try {
        url = await linkClient().pairingUrl();
      } catch (e) {
        ctx.ui.notify(`No pairing QR code: ${(e as Error).message}`, "error");
        return;
      }
      // Never stored in the session: the code holds the bridge's token.
      const lines = [
        ...pairingQr(url).split("\n"),
        "Scan with Pi Mobile. Any key closes.",
      ];
      await ctx.ui.custom<void>((_tui, _theme, _keys, done) => ({
        render: (width: number) => lines.map((line) => line.slice(0, width)),
        handleInput: () => done(),
        invalidate: () => {},
      }));
    },
  });
  const forward = (event: { type: string }) => {
    current?.handle(event as PiEvent);
    print?.run.handle(event as PiEvent);
  };
  pi.on("agent_start", forward);
  pi.on("agent_settled", forward);
  pi.on("message_update", forward);
  pi.on("message_end", forward);
  pi.on("tool_execution_start", forward);
  pi.on("tool_execution_update", forward);
  pi.on("tool_execution_end", forward);
  pi.on("turn_end", forward);
  pi.on("model_select", forward);
  pi.on("thinking_level_select", forward);
  pi.on("session_compact", forward);
  pi.on("session_tree", forward);
}

function host(pi: ExtensionAPI, ctx: ExtensionContext) {
  return {
    send: (text: string, deliverAs?: "steer" | "followUp") =>
      pi.sendUserMessage(text, {
        expandPromptTemplates: true,
        ...(deliverAs && { deliverAs }),
      }),
    abort: () => ctx.abort(),
    isIdle: () => ctx.isIdle(),
    hasPendingMessages: () => ctx.hasPendingMessages(),
    branch: () => ctx.sessionManager.getBranch(),
    entries: () => ctx.sessionManager.getEntries(),
    sessionId: () => ctx.sessionManager.getSessionId(),
    sessionName: () => pi.getSessionName(),
    cwd: ctx.cwd,
    commands: () => pi.getCommands(),
    model: () => ctx.model,
    thinkingLevel: () => pi.getThinkingLevel(),
    thinkingLevels: () =>
      ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"],
    setThinkingLevel: (level: string) =>
      pi.setThinkingLevel(level as ReturnType<typeof pi.getThinkingLevel>),
    contextUsage: () => ctx.getContextUsage(),
    models: () =>
      ctx.scopedModels.length > 0
        ? ctx.scopedModels.map((scoped) => scoped.model)
        : ctx.modelRegistry.getAvailable(),
    setModel: async (provider: string, id: string) => {
      const model = ctx.modelRegistry.find(provider, id);
      if (!model) throw new Error(`unknown model ${provider}/${id}`);
      if (!(await pi.setModel(model)))
        throw new Error(`no credentials for ${provider}`);
    },
  };
}

/**
 * Pi reloads extensions when it replaces a session, but the link belongs to
 * the process: it lives on `globalThis` so a session switch keeps it (and the
 * app following along) instead of looking like a session that ended.
 */
const LINK = Symbol.for("pi-native-client.link");

function linkClient(startBridge = bridgeStarter()): LinkClient {
  const global = globalThis as Record<symbol, LinkClient | undefined>;
  return (global[LINK] ??= new LinkClient(defaultSocketPath(), startBridge));
}

/** Pi is quitting: ends the process's link for good. */
function closeLink(): void {
  const global = globalThis as Record<symbol, LinkClient | undefined>;
  global[LINK]?.close();
  delete global[LINK];
}

/** Least time between two attempts to start the bridge from this process. */
const RESPAWN_MS = 15_000;

/** Rebuilds (`tsc`, incremental-fast) then starts the bridge detached, logging next to its socket, so source edits apply on restart. */
function bridgeStarter(): () => void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const main = join(root, "dist", "main.js");
  let lastStart = -Infinity;
  return () => {
    if (!existsSync(join(root, "tsconfig.build.json"))) return;
    if (Date.now() - lastStart < RESPAWN_MS) return;
    lastStart = Date.now();
    const dir = dirname(defaultSocketPath());
    mkdirSync(dir, { recursive: true });
    const log = openSync(join(dir, "bridge.log"), "a");
    const child = spawn(
      "sh",
      [
        "-c",
        '../node_modules/.bin/tsc -p tsconfig.build.json; exec "$0" "$1"',
        process.env.PI_BRIDGE_NODE ?? "node",
        main,
      ],
      { cwd: root, detached: true, stdio: ["ignore", log, log] }
    );
    child.on("error", () => {});
    child.unref();
  };
}
