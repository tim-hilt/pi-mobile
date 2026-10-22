import {
  parseSkillBlock,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type AgentSessionRuntime,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  GatewayEvent,
  GatewayStats,
  QueuedMessages,
  SessionGateway,
  SessionSummary,
  SkillInfo,
  TranscriptMessage,
} from "./gateway.js";
import { searchWorkspace } from "./fileSearch.js";

/** The slice of pi's `AgentSession` the bridge relies on. */
export type PiSession = Pick<
  AgentSession,
  | "prompt"
  | "steer"
  | "followUp"
  | "abort"
  | "clearQueue"
  | "getSteeringMessages"
  | "getFollowUpMessages"
  | "subscribe"
  | "messages"
  | "resourceLoader"
  | "sessionId"
  | "sessionName"
  | "getSessionStats"
>;

/**
 * The slice of pi's `AgentSessionRuntime` the bridge relies on: it owns the
 * active session and replaces it (tearing the old one down) on new/switch.
 */
export interface PiRuntime extends Pick<
  AgentSessionRuntime,
  "newSession" | "switchSession" | "dispose"
> {
  readonly session: PiSession;
}

/** Lists the stored sessions of a working directory, most recently modified first. */
type ListSessions = (cwd: string) => Promise<SessionInfo[]>;

/**
 * `SessionGateway` backed by a real pi session runtime. Translates pi's
 * session events into gateway events (following the runtime when it replaces
 * the active session) and owns the run lifecycle: a run begins when pi accepts
 * a prompt and ends when pi reports it has settled.
 */
export class PiGateway implements SessionGateway {
  private listeners = new Set<(event: GatewayEvent) => void>();
  private running = false;
  /** Stop reason of the latest assistant message of the current run. */
  private lastAssistant:
    { stopReason: string; errorMessage?: string } | undefined;
  private detach: () => void;

  /** `cwd` is the session's working directory: the root of file search and of the session list. */
  constructor(
    private runtime: PiRuntime,
    private cwd: string,
    private listSessions: ListSessions = (dir) => SessionManager.list(dir)
  ) {
    this.detach = this.attach();
  }

  /** The active pi session; replaced by the runtime on new/switch. */
  private get session(): PiSession {
    return this.runtime.session;
  }

  /**
   * Resolves once pi accepts the prompt, not when the run ends: pi's own
   * `prompt()` only resolves at the end of the run. Rejects if pi refuses it.
   */
  prompt(text: string): Promise<void> {
    return new Promise((accepted, refused) => {
      let isAccepted = false;
      this.session
        .prompt(text, {
          source: "rpc",
          preflightResult: () => {
            isAccepted = true;
            this.beginRun();
            accepted();
          },
        })
        .catch((e) => {
          if (!isAccepted) refused(e);
        });
    });
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text, undefined, { source: "rpc" });
  }

  async followUp(text: string): Promise<void> {
    await this.session.followUp(text, undefined, { source: "rpc" });
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  queue(): QueuedMessages {
    return {
      steering: [...this.session.getSteeringMessages()],
      followUp: [...this.session.getFollowUpMessages()],
    };
  }

  clearQueue(): QueuedMessages {
    return this.session.clearQueue();
  }

  transcript(): TranscriptMessage[] {
    const history: TranscriptMessage[] = [];
    for (const message of this.session.messages) {
      if (message.role === "user") {
        history.push({ role: "user", text: userText(message.content) });
      } else if (message.role === "assistant") {
        const text = joinBlocks(message.content, "text");
        const thinking = joinBlocks(message.content, "thinking");
        // A turn that only called tools has nothing to show.
        if (text || thinking)
          history.push({ role: "assistant", text, thinking });
      }
    }
    return history;
  }

  skills(): SkillInfo[] {
    return this.session.resourceLoader
      .getSkills()
      .skills.map(({ name, description }) => ({ name, description }));
  }

  searchFiles(query: string, limit: number): Promise<string[]> {
    return searchWorkspace(this.cwd, query, limit);
  }

  sessionId(): string {
    return this.session.sessionId;
  }

  sessionName(): string | undefined {
    return this.session.sessionName;
  }

  async sessions(): Promise<SessionSummary[]> {
    return (await this.listSessions(this.cwd)).map((info) => ({
      id: info.id,
      ...(info.name !== undefined && { name: info.name }),
      preview: info.firstMessage,
      modifiedAt: info.modified.toISOString(),
      messageCount: info.messageCount,
    }));
  }

  newSession(): Promise<void> {
    return this.replaceSession(() => this.runtime.newSession());
  }

  async switchSession(id: string): Promise<void> {
    const stored = (await this.listSessions(this.cwd)).find((s) => s.id === id);
    if (!stored) throw new Error(`no stored session "${id}"`);
    await this.replaceSession(() => this.runtime.switchSession(stored.path));
  }

  stats(): GatewayStats {
    const { userMessages, assistantMessages, toolCalls, tokens, cost } =
      this.session.getSessionStats();
    return {
      userMessages,
      assistantMessages,
      toolCalls,
      tokens: tokens.total,
      cost,
    };
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Aborts any active run and releases the pi runtime. */
  dispose(): Promise<void> {
    this.detach();
    this.listeners.clear();
    return this.runtime.dispose();
  }

  private attach(): () => void {
    return this.session.subscribe((event) => this.translate(event));
  }

  /**
   * Has the runtime replace the active session, then moves the event
   * subscription and run state over to the replacement. Rejects, leaving the
   * old session in place, if pi cancels the change.
   */
  private async replaceSession(
    change: () => Promise<{ cancelled: boolean }>
  ): Promise<void> {
    const { cancelled } = await change();
    if (cancelled) throw new Error("the session change was cancelled");
    this.detach();
    this.running = false;
    this.lastAssistant = undefined;
    this.detach = this.attach();
    this.emit({ name: "sessionChanged" });
  }

  /** Emits `runStarted` once per run, however many paths report the start. */
  private beginRun(): void {
    if (this.running) return;
    this.running = true;
    this.lastAssistant = undefined;
    this.emit({ name: "runStarted" });
  }

  private translate(event: AgentSessionEvent): void {
    switch (event.type) {
      case "agent_start":
        this.beginRun();
        break;
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta")
          this.emit({ name: "delta", kind: "text", text: update.delta });
        else if (update.type === "thinking_delta")
          this.emit({ name: "delta", kind: "thinking", text: update.delta });
        break;
      }
      case "message_end": {
        const message = event.message;
        if (message.role === "user")
          this.emit({ name: "userMessage", text: userText(message.content) });
        if (message.role !== "assistant") break;
        this.lastAssistant = message;
        this.emit({
          name: "messageEnd",
          text: joinBlocks(message.content, "text"),
          thinking: joinBlocks(message.content, "thinking"),
        });
        break;
      }
      case "queue_update":
        this.emit({
          name: "queue",
          steering: [...event.steering],
          followUp: [...event.followUp],
        });
        break;
      case "tool_execution_start":
        this.emit({
          name: "toolCall",
          phase: "start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        this.emit({
          name: "toolCall",
          phase: "update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: toolOutput(event.partialResult),
        });
        break;
      case "tool_execution_end":
        this.emit({
          name: "toolCall",
          phase: "end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          output: toolOutput(event.result),
          isError: event.isError,
          ...(event.durationMs !== undefined && {
            durationMs: event.durationMs,
          }),
        });
        break;
      case "agent_settled":
        this.running = false;
        this.emit(this.settled(event.aborted));
        break;
    }
  }

  /**
   * Pi's `agent_settled` only says whether the run was aborted; whether it
   * failed is recorded on the final assistant message. Earlier failures that
   * a retry recovered from are superseded by that final message.
   */
  private settled(aborted: boolean): GatewayEvent {
    const { stopReason, errorMessage } = this.lastAssistant ?? {};
    if (aborted || stopReason === "aborted")
      return { name: "runSettled", stopReason: "aborted" };
    if (stopReason === "error")
      return {
        name: "runSettled",
        stopReason: "error",
        ...(errorMessage !== undefined && { errorMessage }),
      };
    if (stopReason === "length")
      return { name: "runSettled", stopReason: "length" };
    return { name: "runSettled", stopReason: "success" };
  }

  private emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * The text of a user message, whose content is a plain string or blocks (images dropped).
 * Pi expands `/skill:name args` into the skill's body before sending; the user
 * sees what they typed.
 */
function userText(
  content: string | ReadonlyArray<{ type: string; text?: string }>
): string {
  const text =
    typeof content === "string" ? content : joinBlocks(content, "text");
  const skill = parseSkillBlock(text);
  if (!skill) return text;
  return `/skill:${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}`;
}

/** Concatenates the `kind` blocks of a message's content (`text` or `thinking`). */
function joinBlocks(
  content: ReadonlyArray<{ type: string; text?: string; thinking?: string }>,
  kind: "text" | "thinking"
): string {
  let joined = "";
  for (const block of content) {
    if (block.type === "text" && kind === "text") joined += block.text ?? "";
    else if (block.type === "thinking" && kind === "thinking")
      joined += block.thinking ?? "";
  }
  return joined;
}

/** The text of a pi tool result; images and other content are dropped. */
function toolOutput(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (result?.content ?? [])
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}
