import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSocketPath } from "./link.js";
import { LinkClient } from "./linkClient.js";
import { pairingQr } from "./pairing.js";
import { PiShare, type PiEvent } from "./piShare.js";

/**
 * Pi extension that shares every interactive pi session with the bridge, so
 * the app can list and join it. The first pi to find no bridge starts one
 * (detached, outliving it); see README. `/show-bridge-qr` shows the QR code
 * the app scans to log in.
 */
export default function share(pi: ExtensionAPI) {
  let current: PiShare | undefined;

  pi.on("session_start", (_event, ctx) => {
    // Print and JSON runs are one-shot; only sessions someone works in are shared.
    if (!ctx.hasUI) return;
    const link = linkClient();
    current = new PiShare(host(pi, ctx), (record) => link.send(record));
    link.attach(current);
  });
  pi.on("session_info_changed", () => current?.infoChanged());
  pi.on("session_shutdown", (event) => {
    if (!current) return;
    const link = linkClient();
    link.detach(current);
    current = undefined;
    // Otherwise pi is replacing the session and the next one re-announces on the same link.
    if (event.reason === "quit") {
      link.close();
      delete (globalThis as Record<symbol, unknown>)[LINK];
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
  const forward = (event: { type: string }) =>
    current?.handle(event as PiEvent);
  pi.on("agent_start", forward);
  pi.on("agent_settled", forward);
  pi.on("message_update", forward);
  pi.on("message_end", forward);
  pi.on("tool_execution_start", forward);
  pi.on("tool_execution_update", forward);
  pi.on("tool_execution_end", forward);
  pi.on("turn_end", forward);
  pi.on("model_select", forward);
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
    model: () => ctx.model?.id,
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

function linkClient(): LinkClient {
  const global = globalThis as Record<symbol, LinkClient | undefined>;
  return (global[LINK] ??= new LinkClient(
    defaultSocketPath(),
    bridgeStarter()
  ));
}

/** Least time between two attempts to start the bridge from this process. */
const RESPAWN_MS = 15_000;

/** Starts the built bridge (`npm run build -w bridge`) detached, logging next to its socket. */
function bridgeStarter(): () => void {
  const main = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "dist",
    "main.js"
  );
  let lastStart = -Infinity;
  return () => {
    if (!existsSync(main)) return;
    if (Date.now() - lastStart < RESPAWN_MS) return;
    lastStart = Date.now();
    const dir = dirname(defaultSocketPath());
    mkdirSync(dir, { recursive: true });
    const log = openSync(join(dir, "bridge.log"), "a");
    const child = spawn(process.env.PI_BRIDGE_NODE ?? "node", [main], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.on("error", () => {});
    child.unref();
  };
}
