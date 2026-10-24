import { homedir } from "node:os";
import { join } from "node:path";
import type { Socket } from "node:net";
import type {
  GatewayEvent,
  GatewayStats,
  ModelInfo,
  SessionHistory,
  SharedSessionInfo,
  SkillInfo,
} from "./gateway.js";

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
  | { type: "reply"; id: number; result?: unknown; error?: string }
  /** Asks for the app's pairing URL; allowed before `announce`. */
  | { type: "pairing" };

/** Bridge → pi: answers `pairing`, with the URL or why there is none. */
export type PairingRecord = { type: "pairing"; url?: string; error?: string };

/** Bridge → pi: a request pi answers with one `reply` of the same `id`. */
export type CallRecord = { type: "call"; id: number } & Call;

export type Call =
  | { method: "prompt" | "steer" | "followUp"; text: string }
  | { method: "setModel"; provider: string; modelId: string }
  | { method: "abort" | "history" | "skills" | "stats" | "models" };

/** What each call resolves with. */
export interface CallResults {
  prompt: void;
  steer: void;
  followUp: void;
  abort: void;
  history: SessionHistory;
  skills: SkillInfo[];
  stats: GatewayStats;
  models: ModelInfo[];
  setModel: void;
}

/** Sends `record` as one line. */
export const write = (
  socket: Socket,
  record: ShareRecord | CallRecord | PairingRecord
) => socket.write(JSON.stringify(record) + "\n");

/** Calls `onRecord` for every complete line on `socket`; malformed lines are skipped. */
export function readRecords<T>(socket: Socket, onRecord: (record: T) => void) {
  let buffered = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      let record: T;
      try {
        record = JSON.parse(line) as T;
      } catch {
        continue;
      }
      onRecord(record);
    }
  });
}
