import type { RunNotifier, SettledRun } from "./ntfy.js";
import type { PresenceProbe } from "./presence.js";

/** After a notification, the same session's next one waits this long. */
const COOLDOWN_MS = 5000;

/**
 * Decides whether a settled run is worth telling the user about, and passes
 * those that are on to `delivery`. A run notifies iff the user isn't known to
 * be looking at it (away, or its terminal not focused) and the session
 * wasn't notified within the last 5 s. Aborted runs never reach the gate.
 * Anything unknown counts as not looking: it never swallows a notification.
 */
export class NotificationGate implements RunNotifier {
  /** When each session was last notified, in `Date.now()` ms. */
  private lastNotified = new Map<string, number>();

  constructor(
    private readonly delivery: RunNotifier,
    /** Asked once per settled run, never otherwise. */
    private readonly presence: PresenceProbe
  ) {}

  runSettled(run: SettledRun): void {
    void this.presence().then((presence) => {
      // Terminal focus isn't reported yet: always unknown, so never focused.
      const terminalFocused = false;
      if (presence === "present" && terminalFocused) return;
      // Decided and recorded synchronously: a burst can't slip past the cooldown.
      const now = Date.now();
      const last = this.lastNotified.get(run.sessionId);
      if (last !== undefined && now - last < COOLDOWN_MS) return;
      this.lastNotified.set(run.sessionId, now);
      this.delivery.runSettled(run);
    });
  }
}
