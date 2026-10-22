import type { GatewayEvent, SessionGateway } from "./gateway.js";

/** Scriptable `SessionGateway` double: tests drive events and observe how prompts were routed. */
export class FakeGateway implements SessionGateway {
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  readonly followUps: string[] = [];
  /** When set, the next call to any prompt method rejects with it. */
  failNextWith: Error | undefined;

  private listeners = new Set<(event: GatewayEvent) => void>();

  prompt = (text: string) => this.accept(this.prompts, text);
  steer = (text: string) => this.accept(this.steers, text);
  followUp = (text: string) => this.accept(this.followUps, text);

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Delivers a session event to every subscriber, as pi would. */
  emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async accept(into: string[], text: string): Promise<void> {
    const failure = this.failNextWith;
    this.failNextWith = undefined;
    if (failure) throw failure;
    into.push(text);
  }
}
