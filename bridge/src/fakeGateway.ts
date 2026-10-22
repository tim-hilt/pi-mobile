import type {
  GatewayEvent,
  QueuedMessages,
  SessionGateway,
  SkillInfo,
  TranscriptMessage,
} from "./gateway.js";

/** Scriptable `SessionGateway` double: tests drive events and observe how prompts were routed. */
export class FakeGateway implements SessionGateway {
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  readonly followUps: string[] = [];
  /** What `transcript()` reports; tests set it to the history they want snapshotted. */
  messages: TranscriptMessage[] = [];
  /** What `skills()` reports. */
  skillList: SkillInfo[] = [];
  /** Workspace files `searchFiles` draws from, filtered by simple substring match. */
  files: string[] = [];
  /** The `(query, limit)` of every `searchFiles` call. */
  readonly searches: Array<[string, number]> = [];
  aborts = 0;
  /** What `queue()` reports; tests set it to the pending messages they want snapshotted. */
  pending: QueuedMessages = { steering: [], followUp: [] };
  /** When set, the next call to `prompt`, `steer`, `followUp` or `abort` rejects with it. */
  failNextWith: Error | undefined;

  private listeners = new Set<(event: GatewayEvent) => void>();

  prompt = (text: string) => this.accept(this.prompts, text);
  steer = (text: string) => this.accept(this.steers, text);
  followUp = (text: string) => this.accept(this.followUps, text);

  abort = async () => {
    this.throwIfFailing();
    this.aborts++;
  };

  queue = () => this.pending;

  /** Like pi, announces the now-empty queue. */
  clearQueue = () => {
    const cleared = this.pending;
    this.pending = { steering: [], followUp: [] };
    this.emit({ name: "queue", ...this.pending });
    return cleared;
  };

  transcript = () => this.messages;

  skills = () => this.skillList;

  searchFiles = async (query: string, limit: number) => {
    this.throwIfFailing();
    this.searches.push([query, limit]);
    return this.files.filter((f) => f.includes(query)).slice(0, limit);
  };

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Delivers a session event to every subscriber, as pi would. */
  emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async accept(into: string[], text: string): Promise<void> {
    this.throwIfFailing();
    into.push(text);
  }

  private throwIfFailing(): void {
    const failure = this.failNextWith;
    this.failNextWith = undefined;
    if (failure) throw failure;
  }
}
