import { randomUUID } from "node:crypto";
import type {
  GatewayEvent,
  GatewayStats,
  QueuedMessages,
  SessionGateway,
  SessionSummary,
  SkillInfo,
} from "./gateway.js";
import type { RunNotifier } from "./ntfy.js";

/** A bridge → app event as it goes on the wire, minus the `type` discriminator. */
export interface BridgeEvent {
  seq: number;
  name: string;
  data: Record<string, unknown>;
}

/** A command the bridge refuses; surfaces to the app as a `result` with this `error`. */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

/** How many sessions `sessions()` lists. */
const RECENT_SESSIONS = 30;

/** `GatewayStats` plus the run timing only the bridge observes. */
export interface SessionStats extends GatewayStats {
  /** Runs that settled since this session became current. */
  runs: number;
  /** Their total duration. */
  runDurationMs: number;
}

/**
 * The session as the protocol sees it: turns the gateway's events into
 * sequenced `BridgeEvent`s (adding run timing), remembers recent ones so a
 * reconnecting client can catch up, and routes prompts to the gateway
 * according to whether a run is active. Every settled run is also announced
 * to `notifier`, whether or not anyone is connected.
 */
export class Session {
  /**
   * Names this run of the bridge: `seq` restarts with every process, so a
   * cursor is only meaningful alongside the epoch it was handed out in.
   */
  readonly epoch = randomUUID();
  private seq = 0;
  private runStartedAt: number | undefined;
  /** Newest events, oldest first; holds `seq - log.length + 1 .. seq`. */
  private log: BridgeEvent[] = [];
  private runs = 0;
  private runDurationMs = 0;
  /** The assistant message being generated: its deltas so far, not yet in the gateway's transcript. */
  private streaming: { text: string; thinking: string } | undefined;
  private listeners = new Set<(event: BridgeEvent) => void>();
  private detach: () => void;

  constructor(
    private gateway: SessionGateway,
    private replayLimit = 1000,
    private notifier?: RunNotifier
  ) {
    this.detach = gateway.subscribe((event) => this.publish(event));
  }

  /**
   * Brings a client that last saw `lastSeq` (of this `epoch`) up to date, then keeps it live:
   * `listener` first receives what it missed — the events after `lastSeq` when
   * they are all still retained, otherwise one `transcript` snapshot carrying
   * the current seq — and then every new event. Delivery is gapless: catch-up
   * and subscription happen in one step. A fresh client (`lastSeq` 0) always
   * gets the snapshot, since history predates the bridge's event log.
   * Returns the unsubscribe function.
   */
  subscribe(
    lastSeq: number,
    listener: (event: BridgeEvent) => void
  ): () => void {
    const replayable =
      lastSeq > 0 &&
      lastSeq <= this.seq &&
      lastSeq >= this.seq - this.log.length;
    if (replayable) {
      for (const event of this.log.slice(
        this.log.length - (this.seq - lastSeq)
      ))
        listener(event);
    } else {
      listener(this.snapshot());
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Sends `text` to the agent. On an idle session it starts a run and `mode`
   * is irrelevant. During a run, `mode` picks steering or follow-up delivery;
   * omitting it is refused rather than guessed. Rejects with `CommandError`
   * on refusal, or with the gateway's own error if it refuses the prompt.
   */
  async prompt(text: string, mode?: "steer" | "followUp"): Promise<void> {
    if (this.runStartedAt === undefined) return this.gateway.prompt(text);
    if (mode === "steer") return this.gateway.steer(text);
    if (mode === "followUp") return this.gateway.followUp(text);
    throw new CommandError(
      "runActive",
      'a run is active; set mode to "steer" or "followUp"'
    );
  }

  /** Stops the active run; a no-op when idle. Rejects with the gateway's own error if it fails. */
  abort(): Promise<void> {
    return this.gateway.abort();
  }

  /** Drops every queued message and returns the dropped texts. */
  clearQueue(): QueuedMessages {
    return this.gateway.clearQueue();
  }

  /** The most recent stored sessions, newest first, and which one is current. */
  async sessions(): Promise<{
    sessions: SessionSummary[];
    currentId: string;
  }> {
    const all = await this.gateway.sessions();
    return {
      sessions: all.slice(0, RECENT_SESSIONS),
      currentId: this.gateway.sessionId(),
    };
  }

  /**
   * Replaces the session with a fresh one. Listeners then receive its empty
   * snapshot as the next event. Rejects with `CommandError` while a run is active.
   */
  async newSession(): Promise<void> {
    this.assertIdle("starting a new session");
    await this.gateway.newSession();
  }

  /**
   * Makes the stored session `id` current; listeners then receive its snapshot
   * as the next event. Switching to the current session changes nothing.
   * Rejects with `CommandError` for an unknown `id` or while a run is active.
   */
  async switchSession(id: string): Promise<void> {
    this.assertIdle("switching sessions");
    if (id === this.gateway.sessionId()) return;
    const known = (await this.gateway.sessions()).some((s) => s.id === id);
    if (!known)
      throw new CommandError("unknownSession", `no session with id "${id}"`);
    await this.gateway.switchSession(id);
  }

  /** The current session's counts, with the runs this bridge has timed for it. */
  stats(): SessionStats {
    return {
      ...this.gateway.stats(),
      runs: this.runs,
      runDurationMs: this.runDurationMs,
    };
  }

  /** The skills the user can invoke as `/skill:<name>`. */
  skills(): SkillInfo[] {
    return this.gateway.skills();
  }

  /** Workspace files matching `query`, best first; see `SessionGateway.searchFiles`. */
  searchFiles(query: string, limit: number): Promise<string[]> {
    return this.gateway.searchFiles(query, limit);
  }

  close(): void {
    this.detach();
    this.listeners.clear();
  }

  /** The complete transcript as one event; shares the seq of the latest event it reflects. */
  private snapshot(): BridgeEvent {
    const messages: Record<string, unknown>[] = [...this.gateway.transcript()];
    if (this.streaming)
      messages.push({ role: "assistant", ...this.streaming, streaming: true });
    const startedAt = this.runStartedAt;
    const running = startedAt !== undefined;
    return {
      seq: this.seq,
      name: "transcript",
      data: {
        messages,
        running,
        sessionId: this.gateway.sessionId(),
        ...this.gateway.queue(),
        // The app has no other way to learn when a run it joined midway began.
        ...(running && {
          elapsedMs: Math.round(performance.now() - startedAt),
        }),
      },
    };
  }

  private assertIdle(action: string): void {
    if (this.runStartedAt !== undefined)
      throw new CommandError(
        "runActive",
        `a run is active; abort it before ${action}`
      );
  }

  /**
   * Starts the event history over for a replaced session. The switch takes a
   * seq of its own and the log is emptied, so a cursor from before it can
   * never replay the old session's events: it falls back to a snapshot.
   */
  private restart(): void {
    this.runStartedAt = undefined;
    this.streaming = undefined;
    this.runs = 0;
    this.runDurationMs = 0;
    this.log = [];
    this.seq++;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private publish(event: GatewayEvent): void {
    if (event.name === "sessionChanged") return this.restart();
    const { name, ...data } = event;
    if (event.name === "runStarted") {
      this.runStartedAt = performance.now();
      this.streaming = undefined;
    } else if (event.name === "delta") {
      this.streaming ??= { text: "", thinking: "" };
      this.streaming[event.kind] += event.text;
    } else if (event.name === "messageEnd") {
      this.streaming = undefined;
    } else if (event.name === "runSettled") {
      const durationMs = Math.round(
        performance.now() - (this.runStartedAt ?? 0)
      );
      this.runStartedAt = undefined;
      this.streaming = undefined;
      this.runs++;
      this.runDurationMs += durationMs;
      Object.assign(data, { durationMs });
      const sessionName = this.gateway.sessionName();
      this.notifier?.runSettled({
        sessionId: this.gateway.sessionId(),
        ...(sessionName !== undefined && { sessionName }),
        stopReason: event.stopReason,
        durationMs,
      });
    }
    const wire = { seq: ++this.seq, name, data };
    this.log.push(wire);
    if (this.log.length > this.replayLimit) this.log.shift();
    for (const listener of this.listeners) listener(wire);
  }
}
