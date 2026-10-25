/** How a prompt sent during a run reaches the agent. */
export type PromptMode = "steer" | "followUp";

/**
 * What the bridge can ask of a shared pi session: the single list of calls,
 * implemented by `PiShare` in pi and invoked across the Share Link through
 * `SessionGateway.call`. A method answers synchronously unless pi decides
 * later (it then returns a Promise); throwing refuses the call, with a
 * `CommandError`'s code if it has one.
 */
export interface ShareCalls {
  /**
   * Sends `text` to the agent: on an idle session it starts a run and `mode`
   * is irrelevant; during a run `mode` picks steering or follow-up delivery,
   * and omitting it is refused (`runActive`) rather than guessed.
   */
  prompt(text: string, mode?: PromptMode): void;
  /** Stops the active run, if any; the run then settles as `aborted`. */
  abort(): void;
  /**
   * The session's completed messages and tool calls, oldest first, its queue
   * and status: the authoritative state behind a snapshot. Excludes a message
   * still being generated.
   */
  history(): SessionHistory;
  /** The skills the session can invoke as `/skill:<name>`. */
  skills(): SkillInfo[];
  /** The models the session can switch to, as pi's `/model` offers them. */
  models(): ModelInfo[];
  /**
   * Makes `provider`'s model `id` the session's model; the change then shows
   * as a `status` event. Rejects if pi can't (unknown model, no credentials).
   */
  setModel(provider: string, id: string): Promise<void>;
  /** Message, tool and token counts of the whole session. */
  stats(): GatewayStats;
}

/** The `ShareCalls` the bridge makes through `SessionGateway.call`; `history` has its own path. */
export type CallMethod = Exclude<keyof ShareCalls, "history">;

/**
 * The bridge's only view of one shared pi session: a narrow facade the
 * protocol layer depends on alone, so it can be tested against a fake and the
 * real pi link (`LinkGateway`) swapped in without touching it.
 */
export interface SessionGateway {
  /** Makes `method` on pi's side; resolves once pi has answered, rejects if pi refused. */
  call<M extends CallMethod>(
    method: M,
    ...args: Parameters<ShareCalls[M]>
  ): Promise<Awaited<ReturnType<ShareCalls[M]>>>;
  /**
   * Fetches `ShareCalls.history`. `onHistory` runs in line with the event
   * stream (not a later microtask, unlike a Promise): the history reflects
   * every event emitted before the call and none after. It gets `undefined`
   * when pi can't answer, which only happens as the session ends or is
   * replaced.
   */
  history(onHistory: (history: SessionHistory | undefined) => void): void;
  /**
   * Workspace files matching `query` (prefix or fuzzy, best first), at most
   * `limit`, as paths relative to the session's working directory.
   */
  searchFiles(query: string, limit: number): Promise<string[]>;
  /** Identity of the session pi currently runs; replaced on `sessionChanged`, updated on `infoChanged`. */
  info(): SharedSessionInfo;
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
export interface SessionHistory extends QueuedMessages, SessionStatus {
  messages: TranscriptMessage[];
}

/** What a status bar shows about the session, as pi's footer does. */
export interface SessionStatus {
  /** Id of the active model; absent when none is selected. */
  model?: string;
  /** Tokens the model's context holds; absent when unknown (no model, or compacted since its last answer). */
  contextTokens?: number;
  /** Size of the active model's context window; absent when no model is selected. */
  contextWindow?: number;
  /** Price of the whole session so far, in USD. */
  cost: number;
}

/** A skill the user can invoke by name. */
export interface SkillInfo {
  name: string;
  description: string;
}

/** A model the session can switch to. `id` is unique only within its `provider`. */
export interface ModelInfo {
  provider: string;
  id: string;
  /** Human-readable name. */
  name: string;
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
  /** The session's name or preview changed: `info()` has the new one. Not sent to the app. */
  | { name: "infoChanged" }
  /** A user message entered the conversation: the prompt itself, or a steer/follow-up pi took in. */
  | { name: "userMessage"; text: string }
  /** The pending queue changed; carries its full new contents. */
  | ({ name: "queue" } & QueuedMessages)
  /** The status changed; carries all of it. */
  | ({ name: "status" } & SessionStatus)
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
