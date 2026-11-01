import type { ShareRecord } from "./link.js";
import {
  joinBlocks,
  runOutcome,
  type PiEvent,
  type PiMessage,
} from "./piShare.js";

/** What `PrintRun` needs from the pi process it runs in. */
export interface PrintHost {
  sessionId(): string;
  sessionName(): string | undefined;
  cwd: string;
}

/**
 * The runs of a print-mode pi (`pi -p`), which isn't shared as a session:
 * follows pi's events and sends one `settled` record per run that wasn't
 * aborted, so the bridge can announce it.
 */
export class PrintRun {
  private lastAssistant: (PiMessage & { role: "assistant" }) | undefined;
  /** Text of the run's latest assistant message that had any. */
  private lastText: string | undefined;

  constructor(
    private host: PrintHost,
    private sink: (record: ShareRecord) => void
  ) {}

  /** Translates one pi event; those that don't bear on a run are ignored. */
  handle(event: PiEvent): void {
    switch (event.type) {
      case "agent_start":
        this.lastAssistant = undefined;
        this.lastText = undefined;
        break;
      case "message_end": {
        const message = event.message as PiMessage;
        if (message.role !== "assistant") break;
        this.lastAssistant = message;
        const text = joinBlocks(message.content, "text");
        if (text.trim()) this.lastText = text;
        break;
      }
      case "agent_settled": {
        const { stopReason, errorMessage } = runOutcome(
          event.aborted === true,
          this.lastAssistant
        );
        if (stopReason === "aborted") break;
        const name = this.host.sessionName();
        this.sink({
          type: "settled",
          run: {
            sessionId: this.host.sessionId(),
            cwd: this.host.cwd,
            ...(name !== undefined && { sessionName: name }),
            stopReason,
            ...(errorMessage !== undefined && { errorMessage }),
            ...(this.lastText !== undefined && { lastText: this.lastText }),
          },
        });
        break;
      }
    }
  }
}
