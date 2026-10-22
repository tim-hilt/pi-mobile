import type {
  GatewayEvent,
  QueuedMessages,
  SessionGateway,
} from "./gateway.js";

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

/**
 * The session as the protocol sees it: turns the gateway's events into
 * sequenced `BridgeEvent`s (adding run timing), remembers recent ones so a
 * reconnecting client can catch up, and routes prompts to the gateway
 * according to whether a run is active.
 */
export class Session {
  private seq = 0;
  private runStartedAt: number | undefined;
  /** Newest events, oldest first; holds `seq - log.length + 1 .. seq`. */
  private log: BridgeEvent[] = [];
  /** The assistant message being generated: its deltas so far, not yet in the gateway's transcript. */
  private streaming: { text: string; thinking: string } | undefined;
  private listeners = new Set<(event: BridgeEvent) => void>();
  private detach: () => void;

  constructor(
    private gateway: SessionGateway,
    private replayLimit = 1000
  ) {
    this.detach = gateway.subscribe((event) => this.publish(event));
  }

  /**
   * Brings a client that last saw `lastSeq` up to date, then keeps it live:
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
        ...this.gateway.queue(),
        // The app has no other way to learn when a run it joined midway began.
        ...(running && {
          elapsedMs: Math.round(performance.now() - startedAt),
        }),
      },
    };
  }

  private publish(event: GatewayEvent): void {
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
      Object.assign(data, { durationMs });
    }
    const wire = { seq: ++this.seq, name, data };
    this.log.push(wire);
    if (this.log.length > this.replayLimit) this.log.shift();
    for (const listener of this.listeners) listener(wire);
  }
}
