import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import { createInterface } from "node:readline";
import type { GatewayEvent, SharedSessionInfo, ShareCalls } from "./gateway.js";

/**
 * The Share Link: how a pi process shares its session with the bridge. One
 * unix-socket connection per pi process, NDJSON records both ways. Local only,
 * so unauthenticated; the socket file is private to the user.
 */

/** Where the bridge listens for pi processes. */
export const defaultSocketPath = () =>
  process.env.PI_BRIDGE_SOCKET ??
  join(homedir(), ".pi", "agent", "bridge.sock");

/** pi → bridge. */
export type ShareRecord =
  /** First record, and again whenever pi replaces its session. */
  | { type: "announce"; info: SharedSessionInfo }
  /** The session's name or preview changed. */
  | { type: "info"; info: SharedSessionInfo }
  | { type: "event"; event: GatewayEvent }
  /** Answers the `call` with this `id`: its `result`, or `error` (with the refusal's `code`, if any). */
  | {
      type: "reply";
      id: number;
      result?: unknown;
      error?: string;
      code?: string;
    }
  /** Asks for the app's pairing URL; allowed before `announce`. */
  | { type: "pairing" };

/** Bridge → pi: answers `pairing`, with the URL or why there is none. */
export type PairingRecord = { type: "pairing"; url?: string; error?: string };

/** Bridge → pi: invokes `ShareCalls[method](...args)`; pi answers with one `reply` of the same `id`. */
export type CallRecord = {
  type: "call";
  id: number;
  method: keyof ShareCalls;
  args: unknown[];
};

/** Sends `record` as one line. */
export const write = (
  socket: Socket,
  record: ShareRecord | CallRecord | PairingRecord
) => socket.write(JSON.stringify(record) + "\n");

/**
 * Calls `onRecord` for every line on `socket`, synchronously as each chunk
 * arrives, so records keep their order; malformed lines are skipped.
 */
export function readRecords<T>(socket: Socket, onRecord: (record: T) => void) {
  createInterface({ input: socket })
    .on("line", (line) => {
      if (!line.trim()) return;
      let record: T;
      try {
        record = JSON.parse(line) as T;
      } catch {
        return;
      }
      onRecord(record);
    })
    // Re-emitted socket errors; the socket's owner handles those.
    .on("error", () => {});
}
