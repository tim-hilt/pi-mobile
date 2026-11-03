import { basename } from "node:path";
import type { StopReason } from "./gateway.js";

/** Where the bridge announces settled runs: a topic on an ntfy server. */
export interface NtfyConfig {
  /** Server address, `https://ntfy.sh` unless self-hosted. */
  baseUrl: string;
  /** Unguessable topic name; anyone who knows it can read the announcements. */
  topic: string;
}

/** What a settled run announces; what a print-mode pi reports over the Share Link. */
export interface RunOutcome {
  sessionId: string;
  cwd: string;
  /** Absent while the session has no user-given name. */
  sessionName?: string;
  stopReason: Exclude<StopReason, "aborted">;
  errorMessage?: string;
  /** Text of the run's latest assistant message that had any. */
  lastText?: string;
  /** How long the run took, in milliseconds. */
  durationMs?: number;
  /** Tokens the active model's context holds; absent when unknown. */
  contextTokens?: number;
  /** Size of the active model's context window; absent without a model. */
  contextWindow?: number;
  /** Price of the whole session so far, in USD. */
  cost?: number;
}

/** A settled run, with what the bridge knows about who is looking. */
export interface SettledRun extends RunOutcome {
  /** Whether the run belongs to a listed session; print-mode runs don't, so the app can't open them. */
  listed: boolean;
  /** Whether an app connection is joined to the session, i.e. someone is viewing it. */
  joined: boolean;
  /** Whether the session's terminal is focused; absent when unknown. */
  focused?: boolean;
}

/** Announces runs as they settle. */
export interface RunNotifier {
  /** Fire-and-forget: never throws, and delivery failures are only logged. */
  runSettled(run: SettledRun): void;
}

const ICON = "https://upload.wikimedia.org/wikipedia/commons/8/81/Pi_logo.png";
const OUTCOME: Record<SettledRun["stopReason"], string> = {
  success: "Agent Finished",
  error: "Agent Failed",
  length: "Agent Cut Off",
};

/** Publishes each settled run as an ntfy push notification (see docs/protocol.md, "Notifications"). */
export class NtfyNotifier implements RunNotifier {
  private readonly url: string;

  constructor(private readonly config: NtfyConfig) {
    this.url = config.baseUrl.replace(/\/+$/, "") || config.baseUrl;
  }

  runSettled(run: SettledRun): void {
    const text =
      run.lastText?.trim() || run.errorMessage || "The agent finished.";
    const summary = stats(run).join(" • ");
    const payload = {
      topic: this.config.topic,
      title: `${run.sessionName ?? basename(run.cwd)}: ${OUTCOME[run.stopReason]}`,
      message: summary ? `${summary}\n\n${text}` : text,
      tags: ["robot"],
      markdown: true,
      icon: ICON,
      // Opens Pi Mobile on this session (see docs/protocol.md, "Notifications").
      ...(run.listed && {
        click: `pimobile://session?id=${encodeURIComponent(run.sessionId)}`,
      }),
    };
    // A missed notification must never affect the session it reports on.
    fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((res) => {
        if (!res.ok) console.warn(`ntfy rejected notification: ${res.status}`);
      })
      .catch((e) => console.warn(`ntfy unreachable: ${e}`));
  }
}

/** The run's time, context fill and session cost, e.g. `2m 34s • 70.4k/1.0M • $0.42`. */
function stats(run: SettledRun): string[] {
  const context =
    run.contextWindow !== undefined
      ? `${run.contextTokens !== undefined ? tokens(run.contextTokens) : "?"}/${tokens(run.contextWindow)}`
      : undefined;
  return [
    run.durationMs !== undefined ? duration(run.durationMs) : undefined,
    context,
    run.cost !== undefined ? `$${run.cost.toFixed(2)}` : undefined,
  ].filter((part): part is string => part !== undefined);
}

/** Whole seconds, at most two units, e.g. `1h 2m`, `2m 34s`, `9s`. */
function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** Token count with one decimal, as the app writes it: `999`, `18.8k`, `1.0M`. */
function tokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}
