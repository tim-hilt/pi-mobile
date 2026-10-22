/**
 * The bridge's only view of pi: a narrow facade over a single agent session.
 * The protocol layer depends on this interface alone, so it can be tested
 * against a fake and the real pi adapter can be swapped in without touching it.
 */
export interface SessionGateway {
  /**
   * Starts a run for `text` on an idle session. Resolves once the run is
   * accepted and underway (not when it finishes — completion arrives as a
   * `runSettled` event); rejects if the session refuses the prompt.
   */
  prompt(text: string): Promise<void>;
  /** Queues `text` to enter the active run after the current assistant turn and its tool calls. */
  steer(text: string): Promise<void>;
  /** Queues `text` to be delivered once the active run has finished its pending work. */
  followUp(text: string): Promise<void>;
  /** Stops the active run, if any; the run then settles as `aborted`. Queued messages stay queued. */
  abort(): Promise<void>;
  /** The messages queued by `steer`/`followUp` that pi has not yet taken in. */
  queue(): QueuedMessages;
  /** Drops every queued message and returns what was dropped. */
  clearQueue(): QueuedMessages;
  /**
   * The session's completed messages, oldest first: the authoritative history
   * behind a catch-up snapshot. Excludes a message still being generated.
   */
  transcript(): TranscriptMessage[];
  /** The skills the session can invoke as `/skill:<name>`. */
  skills(): SkillInfo[];
  /**
   * Workspace files matching `query` (prefix or fuzzy, best first), at most
   * `limit`, as paths relative to the session's working directory.
   */
  searchFiles(query: string, limit: number): Promise<string[]>;
  /** Registers `listener` for session events; returns the unsubscribe function. */
  subscribe(listener: (event: GatewayEvent) => void): () => void;
}

/** A skill the user can invoke by name. */
export interface SkillInfo {
  name: string;
  description: string;
}

/** Texts waiting to enter the run, oldest first. */
export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

/** A completed conversation message as the app shows it. */
export type TranscriptMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; thinking: string };

/** How a run ended. `success` is a normal finish; `length` means the model hit its output limit mid-answer. */
export type StopReason = "success" | "error" | "aborted" | "length";

/** Session events in the order pi emits them for one run. */
export type GatewayEvent =
  | { name: "runStarted" }
  /** A user message entered the conversation: the prompt itself, or a steer/follow-up pi took in. */
  | { name: "userMessage"; text: string }
  /** The pending queue changed; carries its full new contents. */
  | ({ name: "queue" } & QueuedMessages)
  | { name: "delta"; kind: "text" | "thinking"; text: string }
  /** The authoritative completed assistant message; supersedes the deltas that built it. */
  | { name: "messageEnd"; text: string; thinking: string }
  /** One tool execution; `output` is the tool's text, with non-text content dropped. */
  | {
      name: "toolCall";
      phase: "start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      name: "toolCall";
      phase: "update";
      toolCallId: string;
      toolName: string;
      /** Output so far (replaces earlier updates, not an increment). */
      output: string;
    }
  | {
      name: "toolCall";
      phase: "end";
      toolCallId: string;
      toolName: string;
      output: string;
      isError: boolean;
      /** Absent when the tool never ran. */
      durationMs?: number;
    }
  /** Pi will not continue on its own. `errorMessage` accompanies `error`. */
  | { name: "runSettled"; stopReason: StopReason; errorMessage?: string };
