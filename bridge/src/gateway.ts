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
  /** Registers `listener` for session events; returns the unsubscribe function. */
  subscribe(listener: (event: GatewayEvent) => void): () => void;
}

/** How a run ended. `success` is a normal finish. */
export type StopReason = "success" | "error" | "aborted";

/** Session events in the order pi emits them for one run. */
export type GatewayEvent =
  | { name: "runStarted" }
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
