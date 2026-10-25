import { randomUUID } from "node:crypto";
import type {
  GatewayEvent,
  GatewayStats,
  SessionGateway,
  SessionHistory,
  SharedSessionInfo,
  StopReason,
} from "./gateway.js";
import type { RunNotifier } from "./ntfy.js";

/** A bridge → app event as it goes on the wire, minus the `type` discriminator. */
export interface BridgeEvent {
  seq: number;
  name: string;
  data: Record<string, unknown>;
}

/** `GatewayStats` plus the run timing only the bridge observes. */
export interface SessionStats extends GatewayStats {
  /** Runs that settled since this session became current. */
  runs: number;
  /** Their total duration. */
  runDurationMs: number;
}

/** A live session as `getSessions` lists it. */
export interface LiveSession extends SharedSessionInfo {
  running: boolean;
  /** How the latest run settled; absent until one has since pi began the session. */
  lastStopReason?: StopReason;
  /** ISO 8601 time of the latest event. */
  activeAt: string;
}

type Listener = (event: BridgeEvent) => void;

/** What a `Session` gets from its hub. */
interface SessionOptions {
  /** Events kept for replay on rejoin; older cursors get a snapshot. */
  replayLimit: number;
  /** Told about every settled run, whether or not anyone has joined. */
  notifier?: RunNotifier;
  /** Called whenever `describe()` changes other than in `activeAt`. */
  onChange: () => void;
}

/**
 * One shared pi session as the protocol sees it: turns the gateway's events
 * into sequenced `BridgeEvent`s (adding run timing) and remembers recent ones
 * so a rejoining client can catch up. Calls to pi go to `gateway` directly.
 */
export class Session {
  /**
   * Names this share: `seq` restarts with every one, so a cursor is only
   * meaningful alongside the epoch it was handed out in.
   */
  readonly epoch = randomUUID();
  private seq = 0;
  private runStartedAt: number | undefined;
  private lastStopReason: StopReason | undefined;
  /** Newest events, oldest first; holds `seq - log.length + 1 .. seq`. */
  private log: BridgeEvent[] = [];
  private runs = 0;
  private runDurationMs = 0;
  private activeAt = new Date();
  /** The assistant message being generated: its deltas so far, not yet in the gateway's history. */
  private streaming: { text: string; thinking: string } | undefined;
  /** Text of the current run's latest assistant message that had any, for the notifier. */
  private lastText: string | undefined;
  /** Joined clients; `false` while one waits for its snapshot and gets no events yet. */
  private listeners = new Map<Listener, boolean>();
  private detach: () => void;

  constructor(
    readonly gateway: SessionGateway,
    private options: SessionOptions
  ) {
    this.detach = gateway.subscribe((event) => this.publish(event));
  }

  /** The session as `getSessions` lists it. */
  describe(): LiveSession {
    return {
      ...this.gateway.info(),
      running: this.runStartedAt !== undefined,
      ...(this.lastStopReason && { lastStopReason: this.lastStopReason }),
      activeAt: this.activeAt.toISOString(),
    };
  }

  get id(): string {
    return this.gateway.info().id;
  }

  /**
   * Brings a client that last saw `lastSeq` of `epoch` up to date, then keeps
   * it live: `listener` first receives what it missed — the events after
   * `lastSeq` when they are all still retained, otherwise one `transcript`
   * snapshot carrying the current seq — and then every new event, gaplessly.
   * Returns the unsubscribe function.
   */
  subscribe(lastSeq: number, epoch: unknown, listener: Listener): () => void {
    const replayable =
      epoch === this.epoch &&
      lastSeq > 0 &&
      lastSeq <= this.seq &&
      lastSeq >= this.seq - this.log.length;
    if (replayable) {
      for (const event of this.log.slice(
        this.log.length - (this.seq - lastSeq)
      ))
        listener(event);
      this.listeners.set(listener, true);
    } else {
      this.listeners.set(listener, false);
      this.sendSnapshot([listener]);
    }
    return () => this.listeners.delete(listener);
  }

  /** The session's counts, with the runs this bridge has timed for it. */
  async stats(): Promise<SessionStats> {
    return {
      ...(await this.gateway.call("stats")),
      runs: this.runs,
      runDurationMs: this.runDurationMs,
    };
  }

  /** Pi stopped sharing: joined clients get `sessionEnded`, then nothing more. */
  end(): void {
    this.detach();
    const ended = {
      seq: ++this.seq,
      name: "sessionEnded",
      data: { sessionId: this.id },
    };
    for (const listener of this.listeners.keys()) listener(ended);
    this.listeners.clear();
  }

  /**
   * Fetches the history and sends `targets` a snapshot of it. Until then they
   * get no events: the history reflects every event received before it, so
   * the snapshot at the then-current seq covers them all. Without a history
   * (the session is ending or being replaced, see `SessionGateway.history`)
   * they just go live: `sessionEnded` or a fresh snapshot follows.
   */
  private sendSnapshot(targets: Listener[]): void {
    for (const target of targets) this.listeners.set(target, false);
    const deliver = (history?: SessionHistory) => {
      const snapshot = history && this.snapshot(history);
      for (const target of targets) {
        if (!this.listeners.has(target)) continue;
        if (snapshot) target(snapshot);
        this.listeners.set(target, true);
      }
    };
    this.gateway.history(deliver);
  }

  private snapshot({
    messages: completed,
    ...queueAndStatus
  }: SessionHistory): BridgeEvent {
    const messages: Record<string, unknown>[] = [...completed];
    if (this.streaming)
      messages.push({ role: "assistant", ...this.streaming, streaming: true });
    const startedAt = this.runStartedAt;
    const running = startedAt !== undefined;
    const { id, cwd } = this.gateway.info();
    return {
      seq: this.seq,
      name: "transcript",
      data: {
        sessionId: id,
        cwd,
        messages,
        running,
        ...queueAndStatus,
        // The app has no other way to learn when a run it joined midway began.
        ...(running && {
          elapsedMs: Math.round(performance.now() - startedAt),
        }),
      },
    };
  }

  /**
   * Pi replaced its session: the event history starts over. The switch takes
   * a seq of its own and the log is emptied, so a cursor from before it can
   * never replay the old session's events.
   */
  private restart(): void {
    this.runStartedAt = undefined;
    this.lastStopReason = undefined;
    this.streaming = undefined;
    this.runs = 0;
    this.runDurationMs = 0;
    this.log = [];
    this.seq++;
    this.options.onChange();
    this.sendSnapshot([...this.listeners.keys()]);
  }

  private publish(event: GatewayEvent): void {
    this.activeAt = new Date();
    if (event.name === "sessionChanged") return this.restart();
    if (event.name === "infoChanged") return this.options.onChange();
    const { name, ...data } = event;
    if (event.name === "runStarted") {
      this.runStartedAt = performance.now();
      this.streaming = undefined;
      this.lastText = undefined;
      this.options.onChange();
    } else if (event.name === "delta") {
      this.streaming ??= { text: "", thinking: "" };
      this.streaming[event.kind] += event.text;
    } else if (event.name === "messageEnd") {
      this.streaming = undefined;
      if (event.text.trim()) this.lastText = event.text;
    } else if (event.name === "runSettled") {
      const durationMs = Math.round(
        performance.now() - (this.runStartedAt ?? performance.now())
      );
      this.runStartedAt = undefined;
      this.lastStopReason = event.stopReason;
      this.streaming = undefined;
      this.runs++;
      this.runDurationMs += durationMs;
      Object.assign(data, { durationMs });
      const { id, cwd, name: sessionName } = this.gateway.info();
      this.options.onChange();
      // An interrupted run was the user's own doing: nothing to announce.
      if (event.stopReason !== "aborted")
        this.options.notifier?.runSettled({
          sessionId: id,
          cwd,
          sessionName,
          stopReason: event.stopReason,
          errorMessage: event.errorMessage,
          lastText: this.lastText,
        });
      this.lastText = undefined;
    }
    const wire = { seq: ++this.seq, name, data };
    this.log.push(wire);
    if (this.log.length > this.options.replayLimit) this.log.shift();
    for (const [listener, ready] of this.listeners) if (ready) listener(wire);
  }
}

/** The session list as `SessionHub.watch` reports it. */
type Watcher = (sessions: LiveSession[]) => void;

/** Every session pi currently shares with the bridge. */
export class SessionHub {
  private sessions = new Set<Session>();
  private watchers = new Set<Watcher>();
  private broadcastPending = false;

  constructor(
    private replayLimit = 1000,
    private notifier?: RunNotifier
  ) {}

  add(gateway: SessionGateway): Session {
    const session = new Session(gateway, {
      replayLimit: this.replayLimit,
      notifier: this.notifier,
      onChange: () => this.changed(),
    });
    this.sessions.add(session);
    this.changed();
    return session;
  }

  remove(session: Session): void {
    if (!this.sessions.delete(session)) return;
    session.end();
    this.changed();
  }

  /** Most recently active first. */
  list(): LiveSession[] {
    return [...this.sessions]
      .map((s) => s.describe())
      .sort((a, b) => b.activeAt.localeCompare(a.activeAt));
  }

  /**
   * Calls `watcher` with `list()` now, and again whenever a session comes,
   * goes, or changes how it is listed (`activeAt` alone is no news). Returns
   * the unsubscribe function.
   */
  watch(watcher: Watcher): () => void {
    this.watchers.add(watcher);
    watcher(this.list());
    return () => this.watchers.delete(watcher);
  }

  find(id: string): Session | undefined {
    for (const session of this.sessions) if (session.id === id) return session;
  }

  close(): void {
    for (const session of this.sessions) this.remove(session);
    this.watchers.clear();
  }

  /**
   * Broadcasts the list once the current burst of changes is over (pi
   * announces a session and its active run in one go): one update, not one
   * per change.
   */
  private changed(): void {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    queueMicrotask(() => {
      this.broadcastPending = false;
      if (this.watchers.size === 0) return;
      const sessions = this.list();
      for (const watcher of this.watchers) watcher(sessions);
    });
  }
}
