/** Bridge Protocol version negotiated on connect. See docs/protocol.md. */
export const PROTOCOL_VERSION = 3;

/** `error` payload shared by `result` records and top-level `error` records. */
export interface ProtocolError {
  code: string;
  message: string;
}

/** app → bridge. */
export interface Command {
  id: number;
  name: string;
  params: Record<string, unknown>;
}

/** bridge → app records. */
export type BridgeRecord =
  | { type: "result"; id: number; result: unknown }
  | { type: "result"; id: number; error: ProtocolError }
  /** An event of the joined session, numbered within it. */
  | { type: "event"; seq: number; name: string; data: Record<string, unknown> }
  /** The session list changed; about no single session, so without `seq`. */
  | { type: "event"; name: "sessions"; data: { sessions: unknown[] } }
  /** Connection-level failure that cannot be tied to a command `id`; the socket is closed after it. */
  | { type: "error"; error: ProtocolError };

export class MalformedRecordError extends Error {}

/** A command refused for a known reason; surfaces to the app as a `result` with this `error`. */
export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parses one WebSocket text frame into its newline-separated commands.
 * Throws `MalformedRecordError` if any record is not a well-formed command.
 */
export function parseCommands(frame: string): Command[] {
  return frame
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        throw new MalformedRecordError("record is not valid JSON");
      }
      if (
        !isObject(record) ||
        record.type !== "command" ||
        !Number.isInteger(record.id) ||
        typeof record.name !== "string" ||
        !isObject(record.params)
      ) {
        throw new MalformedRecordError(
          "record is not a command {type, id, name, params}"
        );
      }
      return {
        id: record.id as number,
        name: record.name,
        params: record.params,
      };
    });
}

/** Serializes a record as one newline-terminated frame. */
export const encode = (record: BridgeRecord): string =>
  JSON.stringify(record) + "\n";
