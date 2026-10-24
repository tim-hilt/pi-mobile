import { basename } from "node:path";
import type { StopReason } from "./gateway.js";

/** Where the bridge announces settled runs: a topic on an ntfy server. */
export interface NtfyConfig {
  /** Server address, `https://ntfy.sh` unless self-hosted. */
  baseUrl: string;
  /** Unguessable topic name; anyone who knows it can read the announcements. */
  topic: string;
}

/** What a settled run announces. */
export interface SettledRun {
  sessionId: string;
  cwd: string;
  /** Absent while the session has no user-given name. */
  sessionName?: string;
  stopReason: StopReason;
  errorMessage?: string;
  /** Text of the run's latest assistant message that had any. */
  lastText?: string;
}

/** Announces runs as they settle. */
export interface RunNotifier {
  /** Fire-and-forget: never throws, and delivery failures are only logged. */
  runSettled(run: SettledRun): void;
}

// ntfy rejects messages above 4096 bytes; stay well below.
const MAX_MESSAGE_CHARS = 1000;
const ICON = "https://upload.wikimedia.org/wikipedia/commons/8/81/Pi_logo.png";
const OUTCOME: Record<StopReason, string> = {
  success: "Agent Finished",
  error: "Agent Failed",
  aborted: "Agent Aborted",
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
    const payload = {
      topic: this.config.topic,
      title: `${run.sessionName ?? basename(run.cwd)}: ${OUTCOME[run.stopReason]}`,
      message:
        text.length > MAX_MESSAGE_CHARS
          ? `${text.slice(0, MAX_MESSAGE_CHARS)}…`
          : text,
      tags: ["robot"],
      markdown: true,
      icon: ICON,
      // Opens Pi Mobile on this session (see docs/protocol.md, "Notifications").
      click: `pimobile://session?id=${encodeURIComponent(run.sessionId)}`,
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
