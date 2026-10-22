import type {
  GatewayEvent,
  GatewayStats,
  QueuedMessages,
  SessionGateway,
  SessionSummary,
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
  /** What `sessions()` reports; tests set it to the stored sessions they want listed. */
  sessionList: SessionSummary[] = [];
  /** Transcripts of stored sessions by id; a switch loads one into `messages`. */
  readonly histories: Record<string, TranscriptMessage[]> = {};
  /** Ids passed to `switchSession`, in call order. */
  readonly sessionSwitches: string[] = [];
  /** What `stats()` reports. */
  statistics: GatewayStats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    tokens: 0,
    cost: 0,
  };
  aborts = 0;
  /** What `sessionId()` reports. */
  current = "s1";
  /** What `sessionName()` reports. */
  name: string | undefined;
  private created = 0;
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

  sessionId = () => this.current;

  sessionName = () => this.name;

  sessions = async () => this.sessionList;

  /** Like pi, starts an empty session (listed first) and announces the change. */
  newSession = async () => {
    this.current = `new-${++this.created}`;
    this.messages = [];
    this.sessionList = [
      {
        id: this.current,
        preview: "",
        modifiedAt: new Date(0).toISOString(),
        messageCount: 0,
      },
      ...this.sessionList,
    ];
    this.emit({ name: "sessionChanged" });
  };

  switchSession = async (id: string) => {
    this.sessionSwitches.push(id);
    this.current = id;
    this.messages = this.histories[id] ?? [];
    this.emit({ name: "sessionChanged" });
  };

  stats = () => this.statistics;

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
