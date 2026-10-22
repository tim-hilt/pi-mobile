import type { StopReason } from "./gateway.js";

/** Where the bridge announces settled runs: a topic on an ntfy server. */
export interface NtfyConfig {
  /** Server address, `https://ntfy.sh` unless self-hosted. */
  baseUrl: string;
  /** Unguessable topic name; anyone who knows it can read the announcements, so they stay non-sensitive. */
  topic: string;
}

/**
 * What a settled run announces: which session, how it ended and how long it
 * took. Deliberately no transcript content — the topic is public by obscurity.
 */
export interface SettledRun {
  /** Opaque id, so the app can open the session. */
  sessionId: string;
  /** Absent while the session has no user-given name. */
  sessionName?: string;
  stopReason: StopReason;
  durationMs: number;
}

/** Announces runs as they settle. */
export interface RunNotifier {
  /** Fire-and-forget: never throws, and delivery failures are only logged. */
  runSettled(run: SettledRun): void;
}

/** Publishes each settled run to ntfy as a JSON message (see docs/protocol.md, "Notifications"). */
export class NtfyNotifier implements RunNotifier {
  private readonly url: string;

  constructor({ baseUrl, topic }: NtfyConfig) {
    this.url = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(topic)}`;
  }

  runSettled(run: SettledRun): void {
    // A missed notification must never affect the session it reports on.
    fetch(this.url, { method: "POST", body: JSON.stringify(run) })
      .then((res) => {
        if (!res.ok) console.warn(`ntfy rejected notification: ${res.status}`);
      })
      .catch((e) => console.warn(`ntfy unreachable: ${e}`));
  }
}
