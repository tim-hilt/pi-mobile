import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  GatewayEvent,
  SessionGateway,
  TranscriptMessage,
} from "./gateway.js";

/** The slice of pi's `AgentSession` the bridge relies on. */
export type PiSession = Pick<
  AgentSession,
  "prompt" | "steer" | "followUp" | "subscribe" | "dispose" | "messages"
>;

/**
 * `SessionGateway` backed by a real pi `AgentSession`. Translates pi's session
 * events into gateway events and owns the run lifecycle: a run begins when pi
 * accepts a prompt and ends when pi reports it has settled.
 */
export class PiGateway implements SessionGateway {
  private listeners = new Set<(event: GatewayEvent) => void>();
  private running = false;
  /** Stop reason of the latest assistant message of the current run. */
  private lastAssistant:
    { stopReason: string; errorMessage?: string } | undefined;
  private detach: () => void;

  constructor(private session: PiSession) {
    this.detach = session.subscribe((event) => this.translate(event));
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

  transcript(): TranscriptMessage[] {
    const history: TranscriptMessage[] = [];
    for (const message of this.session.messages) {
      if (message.role === "user") {
        const text =
          typeof message.content === "string"
            ? message.content
            : joinBlocks(message.content, "text");
        history.push({ role: "user", text });
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

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Aborts any active run and releases the pi session. */
  dispose(): void {
    this.detach();
    this.listeners.clear();
    this.session.dispose();
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
