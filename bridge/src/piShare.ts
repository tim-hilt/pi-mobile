import {
  parseSkillBlock,
  type SessionEntry,
  type SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import type {
  GatewayEvent,
  GatewayStats,
  QueuedMessages,
  SessionHistory,
  SessionStatus,
  SharedSessionInfo,
  SkillInfo,
  TranscriptMessage,
} from "./gateway.js";
import type { Call, ShareRecord } from "./link.js";

/** What `PiShare` needs from the pi process it runs in (an extension's `pi` and `ctx`). */
export interface PiHost {
  /** `pi.sendUserMessage`, expanding `/skill:` commands as typed input would. */
  send(text: string, deliverAs?: "steer" | "followUp"): void;
  abort(): void;
  hasPendingMessages(): boolean;
  /** The entries of the session's current branch, oldest first. */
  branch(): SessionEntry[];
  /** Every entry of the session, across branches. */
  entries(): SessionEntry[];
  sessionId(): string;
  sessionName(): string | undefined;
  cwd: string;
  commands(): SlashCommandInfo[];
  /** Id of the active model, if one is selected. */
  model(): string | undefined;
  /** `ctx.getContextUsage()`: undefined without a model; `tokens` is null while unknown. */
  contextUsage(): { tokens: number | null; contextWindow: number } | undefined;
}

/**
 * The pi events after which the status may have changed. Usage is read from
 * the session, which records an assistant message only after its
 * `message_end`, so `turn_end` is the first point its tokens and price show.
 */
const STATUS_CHANGES = new Set([
  "turn_end",
  "agent_settled",
  "model_select",
  "session_compact",
  "session_tree",
]);

/** The pi session events `PiShare` translates; the shapes of pi's extension events. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * One pi session as shared over the Share Link: translates pi's extension
 * events into gateway events, answers the bridge's calls, and owns the run
 * lifecycle — a run begins at pi's `agent_start` and ends when pi reports it
 * settled — and the status (model, context fill, price), sent when it changes. Pi doesn't expose its queue to extensions, so the queue holds only
 * what arrived over the link.
 */
export class PiShare {
  private running = false;
  /** Stop reason of the latest assistant message of the current run. */
  private lastAssistant:
    { stopReason?: string; errorMessage?: string } | undefined;
  private queued: QueuedMessages = { steering: [], followUp: [] };
  /** The first user message; looked up once, then set by the first that arrives. */
  private preview: string | undefined;
  /** The status as the bridge last got it (JSON), to send only changes. */
  private reportedStatus: string;

  constructor(
    private host: PiHost,
    private sink: (record: ShareRecord) => void
  ) {
    // A bridge learns the status from its first history; only later changes are news.
    this.reportedStatus = JSON.stringify(this.status());
  }

  /** Records that introduce the session to a bridge: who it is and, mid-run, that a run is on. */
  introduction(): ShareRecord[] {
    const records: ShareRecord[] = [{ type: "announce", info: this.info() }];
    if (this.running)
      records.push({ type: "event", event: { name: "runStarted" } });
    return records;
  }

  info(): SharedSessionInfo {
    const name = this.host.sessionName();
    if (this.preview === undefined) {
      const first = this.history().messages.find((m) => m.role === "user");
      this.preview = first?.role === "user" ? first.text : "";
    }
    return {
      id: this.host.sessionId(),
      ...(name !== undefined && { name }),
      cwd: this.host.cwd,
      preview: this.preview,
    };
  }

  /** The session's name changed. */
  infoChanged(): void {
    this.sink({ type: "info", info: this.info() });
  }

  /**
   * Answers one bridge call. Synchronous on purpose: the reply must go out
   * before any later event, or a `history` would miss what it claims to cover.
   */
  call(call: Call): unknown {
    switch (call.method) {
      case "prompt":
        return this.host.send(call.text);
      case "steer":
        return this.enqueue("steering", call.text);
      case "followUp":
        return this.enqueue("followUp", call.text);
      case "abort":
        return this.host.abort();
      case "history":
        return this.history();
      case "skills":
        return this.skills();
      case "stats":
        return this.stats();
    }
  }

  /** Translates one pi session event. */
  handle(event: PiEvent): void {
    switch (event.type) {
      case "agent_start":
        if (this.running) break;
        this.running = true;
        this.lastAssistant = undefined;
        this.emit({ name: "runStarted" });
        break;
      case "message_update": {
        const update = event.assistantMessageEvent as {
          type: string;
          delta?: string;
        };
        if (update.type === "text_delta" || update.type === "thinking_delta")
          this.emit({
            name: "delta",
            kind: update.type === "text_delta" ? "text" : "thinking",
            text: update.delta ?? "",
          });
        break;
      }
      case "message_end": {
        const message = event.message as PiMessage;
        if (message.role === "user")
          this.userMessage(userText(message.content));
        if (message.role !== "assistant") break;
        this.lastAssistant = message;
        this.emit({
          name: "messageEnd",
          text: joinBlocks(message.content, "text"),
          thinking: joinBlocks(message.content, "thinking"),
        });
        break;
      }
      case "tool_execution_start":
        this.emit({
          name: "toolCall",
          phase: "start",
          toolCallId: event.toolCallId as string,
          toolName: event.toolName as string,
          args: event.args,
        });
        break;
      case "tool_execution_update":
        this.emit({
          name: "toolCall",
          phase: "update",
          toolCallId: event.toolCallId as string,
          toolName: event.toolName as string,
          output: toolOutput(event.partialResult),
        });
        break;
      case "tool_execution_end":
        this.emit({
          name: "toolCall",
          phase: "end",
          toolCallId: event.toolCallId as string,
          toolName: event.toolName as string,
          output: toolOutput(event.result),
          isError: event.isError as boolean,
          ...(typeof event.durationMs === "number" && {
            durationMs: event.durationMs,
          }),
        });
        break;
      case "agent_settled":
        this.running = false;
        this.emit(this.settled(event.aborted === true));
        // Pi drops or hands back what it didn't take in (e.g. Escape puts it in the editor).
        if (!this.host.hasPendingMessages() && this.hasQueued())
          this.setQueue({ steering: [], followUp: [] });
        break;
    }
    if (STATUS_CHANGES.has(event.type)) this.reportStatus();
  }

  /** The current branch as the app shows it: each tool call after the turn that made it. */
  history(): SessionHistory {
    const messages: TranscriptMessage[] = [];
    /** Tool calls by id, to complete with their result message. */
    const calls = new Map<string, TranscriptMessage & { role: "toolCall" }>();
    for (const entry of this.host.branch()) {
      if (entry.type !== "message") continue;
      const message = entry.message as PiMessage;
      if (message.role === "user") {
        messages.push({ role: "user", text: userText(message.content) });
      } else if (message.role === "assistant") {
        const text = joinBlocks(message.content, "text");
        const thinking = joinBlocks(message.content, "thinking");
        // A turn that only called tools shows just its calls.
        if (text || thinking)
          messages.push({ role: "assistant", text, thinking });
        for (const block of message.content) {
          if (block.type !== "toolCall") continue;
          const call = {
            role: "toolCall" as const,
            toolCallId: block.id!,
            toolName: block.name!,
            args: block.arguments,
          };
          calls.set(call.toolCallId, call);
          messages.push(call);
        }
      } else if (message.role === "toolResult") {
        const call = calls.get(message.toolCallId!);
        if (call)
          Object.assign(call, {
            output: toolOutput(message),
            isError: message.isError,
          });
      }
    }
    const status = this.status();
    this.reportedStatus = JSON.stringify(status);
    return {
      messages,
      steering: [...this.queued.steering],
      followUp: [...this.queued.followUp],
      ...status,
    };
  }

  private status(): SessionStatus {
    const model = this.host.model();
    const context = this.host.contextUsage();
    return {
      ...(model !== undefined && { model }),
      ...(typeof context?.tokens === "number" && {
        contextTokens: context.tokens,
      }),
      ...(context && { contextWindow: context.contextWindow }),
      cost: this.stats().cost,
    };
  }

  /** Sends the status if it changed since the bridge last got it. */
  private reportStatus(): void {
    const status = this.status();
    const json = JSON.stringify(status);
    if (json === this.reportedStatus) return;
    this.reportedStatus = json;
    this.emit({ name: "status", ...status });
  }

  private skills(): SkillInfo[] {
    return this.host
      .commands()
      .filter((c) => c.source === "skill")
      .map((c) => ({
        name: c.name.replace(/^skill:/, ""),
        description: c.description ?? "",
      }));
  }

  /** Counts over the whole session, as pi's `/session` reports them. */
  private stats(): GatewayStats {
    const stats = {
      userMessages: 0,
      assistantMessages: 0,
      toolCalls: 0,
      tokens: 0,
      cost: 0,
    };
    const addUsage = (usage?: PiUsage) => {
      if (!usage) return;
      stats.tokens +=
        usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
      stats.cost += usage.cost.total;
    };
    for (const entry of this.host.entries() as Array<
      SessionEntry & { usage?: PiUsage }
    >) {
      if (entry.type !== "message") {
        addUsage(entry.usage);
        continue;
      }
      const message = entry.message as PiMessage;
      if (message.role === "user") stats.userMessages++;
      else if (message.role === "toolResult") addUsage(message.usage);
      else if (message.role === "assistant") {
        stats.assistantMessages++;
        stats.toolCalls += message.content.filter(
          (c) => c.type === "toolCall"
        ).length;
        addUsage(message.usage);
      }
    }
    return stats;
  }

  private enqueue(kind: keyof QueuedMessages, text: string): void {
    this.host.send(text, kind === "steering" ? "steer" : "followUp");
    this.setQueue({ ...this.queued, [kind]: [...this.queued[kind], text] });
  }

  /** A user message entered the conversation; if it was queued here, it no longer is. */
  private userMessage(text: string): void {
    this.emit({ name: "userMessage", text });
    for (const kind of ["steering", "followUp"] as const) {
      const [first, ...rest] = this.queued[kind];
      if (first !== text) continue;
      this.setQueue({ ...this.queued, [kind]: rest });
      break;
    }
    if (!this.info().preview) {
      this.preview = text;
      this.infoChanged();
    }
  }

  private hasQueued(): boolean {
    return this.queued.steering.length + this.queued.followUp.length > 0;
  }

  private setQueue(queued: QueuedMessages): void {
    this.queued = queued;
    this.emit({
      name: "queue",
      steering: [...queued.steering],
      followUp: [...queued.followUp],
    });
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
    this.sink({ type: "event", event });
  }
}

interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

interface PiBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
}

/** The parts of pi's agent messages the share reads. */
type PiMessage =
  | { role: "user"; content: string | PiBlock[] }
  | {
      role: "assistant";
      content: PiBlock[];
      stopReason?: string;
      errorMessage?: string;
      usage?: PiUsage;
    }
  | {
      role: "toolResult";
      toolCallId?: string;
      content?: PiBlock[];
      isError?: boolean;
      usage?: PiUsage;
    }
  | { role: "other"; content?: unknown };

/**
 * The text of a user message, whose content is a plain string or blocks (images dropped).
 * Pi expands `/skill:name args` into the skill's body before sending; the user
 * sees what they typed.
 */
function userText(content: string | PiBlock[]): string {
  const text =
    typeof content === "string" ? content : joinBlocks(content, "text");
  const skill = parseSkillBlock(text);
  if (!skill) return text;
  return `/skill:${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}`;
}

/** Concatenates the `kind` blocks of a message's content (`text` or `thinking`). */
function joinBlocks(content: PiBlock[], kind: "text" | "thinking"): string {
  let joined = "";
  for (const block of content) {
    if (block.type === "text" && kind === "text") joined += block.text ?? "";
    else if (block.type === "thinking" && kind === "thinking")
      joined += block.thinking ?? "";
  }
  return joined;
}

/** The text of a pi tool result; images and other content are dropped. */
function toolOutput(result: unknown): string {
  const content =
    (result as { content?: PiBlock[] } | undefined)?.content ?? [];
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("");
}
