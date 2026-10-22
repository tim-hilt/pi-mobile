import type { GatewayEvent, SessionGateway } from "./gateway.js";

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
 * sequenced `BridgeEvent`s (adding run timing) and routes prompts to the
 * gateway according to whether a run is active.
 */
export class Session {
  private seq = 0;
  private runStartedAt: number | undefined;
  private listeners = new Set<(event: BridgeEvent) => void>();
  private detach: () => void;

  constructor(private gateway: SessionGateway) {
    this.detach = gateway.subscribe((event) => this.publish(event));
  }

  /** Delivers every subsequent event to `listener`; returns the unsubscribe function. */
  subscribe(listener: (event: BridgeEvent) => void): () => void {
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

  close(): void {
    this.detach();
    this.listeners.clear();
  }

  private publish(event: GatewayEvent): void {
    const { name, ...data } = event;
    if (event.name === "runStarted") {
      this.runStartedAt = performance.now();
    } else if (event.name === "runSettled") {
      const durationMs = Math.round(
        performance.now() - (this.runStartedAt ?? 0)
      );
      this.runStartedAt = undefined;
      Object.assign(data, { durationMs });
    }
    const wire = { seq: ++this.seq, name, data };
    for (const listener of this.listeners) listener(wire);
  }
}
