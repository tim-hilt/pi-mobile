import type {
  GatewayEvent,
  GatewayStats,
  ModelInfo,
  QueuedMessages,
  SessionGateway,
  SessionHistory,
  SessionStatus,
  SharedSessionInfo,
  SkillInfo,
  TranscriptMessage,
} from "./gateway.js";

/** Scriptable `SessionGateway` double: tests drive events and observe how prompts were routed. */
export class FakeGateway implements SessionGateway {
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  readonly followUps: string[] = [];
  /** What `history()` reports; tests set it to the history they want snapshotted. */
  messages: TranscriptMessage[] = [];
  /** What `skills()` reports. */
  skillList: SkillInfo[] = [];
  /** What `models()` reports. */
  modelList: ModelInfo[] = [];
  /** `[provider, id]` of every `setModel` that succeeded. */
  readonly selectedModels: Array<[string, string]> = [];
  /** Workspace files `searchFiles` draws from, filtered by simple substring match. */
  files: string[] = [];
  /** The `(query, limit)` of every `searchFiles` call. */
  readonly searches: Array<[string, number]> = [];
  /** What `stats()` reports. */
  statistics: GatewayStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    tokens: 0,
    cost: 0,
  };
  aborts = 0;
  /** What `info()` reports. */
  current: SharedSessionInfo;
  /** What `history()` reports as the status. */
  status: SessionStatus = { cost: 0 };
  /** What `history()` reports as queued. */
  pending: QueuedMessages = { steering: [], followUp: [] };
  /** When set, the next call to `prompt`, `steer`, `followUp`, `abort`, `setModel` or `searchFiles` rejects with it. */
  failNextWith: Error | undefined;

  private listeners = new Set<(event: GatewayEvent) => void>();

  constructor(id = "s1", extra: Partial<SharedSessionInfo> = {}) {
    this.current = { id, cwd: "/work", preview: `hello from ${id}`, ...extra };
  }

  prompt = (text: string) => this.accept(this.prompts, text);
  steer = (text: string) => this.accept(this.steers, text);
  followUp = (text: string) => this.accept(this.followUps, text);

  abort = async () => {
    this.throwIfFailing();
    this.aborts++;
  };

  history = (onHistory: (history: SessionHistory | undefined) => void) =>
    onHistory({ messages: this.messages, ...this.pending, ...this.status });

  skills = async () => this.skillList;

  models = async () => this.modelList;

  setModel = async (provider: string, id: string) => {
    this.throwIfFailing();
    this.selectedModels.push([provider, id]);
  };

  searchFiles = async (query: string, limit: number) => {
    this.throwIfFailing();
    this.searches.push([query, limit]);
    return this.files.filter((f) => f.includes(query)).slice(0, limit);
  };

  info = () => this.current;

  stats = async () => this.statistics;

  /** Like pi replacing its session (`/new`, `/resume`): becomes `id` with `messages`. */
  replace(id: string, messages: TranscriptMessage[] = []): void {
    this.current = { ...this.current, id, preview: "" };
    this.messages = messages;
    this.emit({ name: "sessionChanged" });
  }

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
