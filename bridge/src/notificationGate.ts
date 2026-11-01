import type { RunNotifier, SettledRun } from "./ntfy.js";
import type { PresenceProbe } from "./presence.js";

/** After a notification, the same session's next one waits this long. */
const COOLDOWN_MS = 5000;

/**
 * Decides whether a settled run is worth telling the user about, and passes
 * those that are on to `delivery`. A run notifies iff nobody is known to be
 * looking at it (no app joined to the session, and its terminal not focused
 * while the user is at the Mac) and the session wasn't notified within the
 * last 5 s. Anything unknown counts as not looking: it never swallows a
 * notification. Aborted runs never reach the gate.
 */
export class NotificationGate implements RunNotifier {
  /** When each session was last notified, in `Date.now()` ms. */
  private lastNotified = new Map<string, number>();

  constructor(
    private readonly delivery: RunNotifier,
    /** Asked only when a run of a focused terminal settles, never otherwise. */
    private readonly presence: PresenceProbe
  ) {}

  runSettled(run: SettledRun): void {
    if (run.joined) return;
    // Presence only matters while the terminal is focused: spare the probe otherwise.
    if (run.focused !== true) return this.deliver(run);
    void this.presence().then((presence) => {
      if (presence !== "present") this.deliver(run);
    });
  }

  /** Delivers `run` unless its session is cooling down; a burst can't slip past, as this is synchronous. */
  private deliver(run: SettledRun): void {
    const now = Date.now();
    const last = this.lastNotified.get(run.sessionId);
    if (last !== undefined && now - last < COOLDOWN_MS) return;
    this.lastNotified.set(run.sessionId, now);
    this.delivery.runSettled(run);
  }
}
