import type {
  CallMethod,
  GatewayEvent,
  ModelInfo,
  PromptMode,
  QueuedMessages,
  SessionGateway,
  SessionHistory,
  SessionStatus,
  ShareCalls,
  SharedSessionInfo,
  SkillInfo,
  TranscriptMessage,
} from "./gateway.js";

/** Scriptable `SessionGateway` double: tests drive events and observe what reached pi. */
export class FakeGateway implements SessionGateway {
  /** Every prompt pi accepted, with its mode if it had one. */
  readonly prompts: Array<{ text: string; mode?: PromptMode }> = [];
  /** What `history()` reports; tests set it to the history they want snapshotted. */
  messages: TranscriptMessage[] = [];
  /** What the `skills` call reports. */
  skillList: SkillInfo[] = [];
  /** What the `models` call reports. */
  modelList: ModelInfo[] = [];
  /** `[provider, id]` of every `setModel` that succeeded. */
  readonly selectedModels: Array<[string, string]> = [];
  /** Every level `setThinkingLevel` was asked for. */
  readonly thinkingLevels: string[] = [];
  /** Workspace files `searchFiles` draws from, filtered by simple substring match. */
  files: string[] = [];
  /** The `(query, limit)` of every `searchFiles` call. */
  readonly searches: Array<[string, number]> = [];
  aborts = 0;
  /** What `info()` reports. */
  current: SharedSessionInfo;
  /** What `history()` reports as the status. */
  status: SessionStatus = { cost: 0 };
  /** What `history()` reports as queued. */
  pending: QueuedMessages = { steering: [], followUp: [] };
  /** When set, the next `call` or `searchFiles` rejects with it. */
  failNextWith: Error | undefined;

  private listeners = new Set<(event: GatewayEvent) => void>();

  /** Pi's side of the calls. */
  private readonly pi: Pick<ShareCalls, CallMethod> = {
    prompt: (text, mode) => void this.prompts.push({ text, mode }),
    abort: () => void this.aborts++,
    skills: () => this.skillList,
    models: () => this.modelList,
    setModel: async (provider, id) =>
      void this.selectedModels.push([provider, id]),
    setThinkingLevel: (level) => void this.thinkingLevels.push(level),
  };

  constructor(id = "s1", extra: Partial<SharedSessionInfo> = {}) {
    this.current = { id, cwd: "/work", preview: `hello from ${id}`, ...extra };
  }

  async call<M extends CallMethod>(
    method: M,
    ...args: Parameters<ShareCalls[M]>
  ): Promise<Awaited<ReturnType<ShareCalls[M]>>> {
    this.throwIfFailing();
    const call = this.pi[method] as (...args: unknown[]) => unknown;
    return (await call(...args)) as Awaited<ReturnType<ShareCalls[M]>>;
  }

  history = (onHistory: (history: SessionHistory | undefined) => void) =>
    onHistory({ messages: this.messages, ...this.pending, ...this.status });

  searchFiles = async (query: string, limit: number) => {
    this.throwIfFailing();
    this.searches.push([query, limit]);
    return this.files.filter((f) => f.includes(query)).slice(0, limit);
  };

  info = () => this.current;

  /** Like pi replacing its session (`/new`, `/resume`): becomes `id` with `messages`. */
  replace(id: string, messages: TranscriptMessage[] = []): void {
    this.current = { ...this.current, id, preview: "" };
    this.messages = messages;
    this.emit({ name: "sessionChanged" });
  }

  /** Like pi renaming the session. */
  rename(name: string): void {
    this.current = { ...this.current, name };
    this.emit({ name: "infoChanged" });
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Delivers a session event to every subscriber, as pi would. */
  emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private throwIfFailing(): void {
    const failure = this.failNextWith;
    this.failNextWith = undefined;
    if (failure) throw failure;
  }
}
