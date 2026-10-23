/**
 * The bridge's only view of one shared pi session: a narrow facade the
 * protocol layer depends on alone, so it can be tested against a fake and the
 * real pi link (`LinkGateway`) swapped in without touching it.
 */
export interface SessionGateway {
  /**
   * Starts a run for `text` on an idle session. Resolves once pi has the text,
   * not when the run ends (that arrives as `runSettled`); rejects if refused.
   */
  prompt(text: string): Promise<void>;
  /** Queues `text` to enter the active run after the current assistant turn and its tool calls. */
  steer(text: string): Promise<void>;
  /** Queues `text` to be delivered once the active run has finished its pending work. */
  followUp(text: string): Promise<void>;
  /** Stops the active run, if any; the run then settles as `aborted`. */
  abort(): Promise<void>;
  /**
   * Fetches the session's completed messages and tool calls, oldest first, and
   * its queue: the authoritative state behind a snapshot. Excludes a message
   * still being generated. `onHistory` runs in line with the event stream (not
   * a later microtask, unlike a Promise): the history reflects every event
   * emitted before the call and none after. It gets `undefined` when pi can't
   * answer, which only happens as the session ends or is replaced.
   */
  history(onHistory: (history: SessionHistory | undefined) => void): void;
  /** The skills the session can invoke as `/skill:<name>`. */
  skills(): Promise<SkillInfo[]>;
  /**
   * Workspace files matching `query` (prefix or fuzzy, best first), at most
   * `limit`, as paths relative to the session's working directory.
   */
  searchFiles(query: string, limit: number): Promise<string[]>;
  /** Identity of the session pi currently runs; replaced on `sessionChanged`. */
  info(): SharedSessionInfo;
  /** Message, tool and token counts of the session. */
  stats(): Promise<GatewayStats>;
  /** Registers `listener` for session events; returns the unsubscribe function. */
  subscribe(listener: (event: GatewayEvent) => void): () => void;
}

/** A live pi session as it identifies itself. */
export interface SharedSessionInfo {
  id: string;
  /** The user-given name, if any. */
  name?: string;
  /** The session's working directory. */
  cwd: string;
  /** The session's first user message, to tell unnamed sessions apart. */
  preview: string;
}

/** The authoritative state behind a snapshot. */
export interface SessionHistory extends QueuedMessages {
  messages: TranscriptMessage[];
}

/** A skill the user can invoke by name. */
export interface SkillInfo {
  name: string;
  description: string;
}

/** What the session has consumed so far; `tokens` and `cost` cover the whole session. */
export interface GatewayStats {
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: number;
  cost: number;
}

/** Texts waiting to enter the run, oldest first. */
export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

/**
 * A completed conversation message as the app shows it, or a tool call, which
 * follows the assistant message that made it.
 */
export type TranscriptMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; thinking: string }
  | {
      role: "toolCall";
      toolCallId: string;
      toolName: string;
      args: unknown;
      /** `output` (text only) and `isError` are absent while the tool has not finished. */
      output?: string;
      isError?: boolean;
    };

/** How a run ended. `success` is a normal finish; `length` means the model hit its output limit mid-answer. */
export type StopReason = "success" | "error" | "aborted" | "length";

/** Session events in the order pi emits them for one run. */
export type GatewayEvent =
  | { name: "runStarted" }
  /** Pi replaced the session (new, resume, fork): `info()` is the new one, nothing of the old one is current. */
  | { name: "sessionChanged" }
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
