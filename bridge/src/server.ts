import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  MalformedRecordError,
  PROTOCOL_VERSION,
  encode,
  parseCommands,
  type BridgeRecord,
  type Command,
} from "./protocol.js";

export interface BridgeOptions {
  /** Bearer token every request and WebSocket upgrade must present. */
  token: string;
  /** TCP port on localhost; 0 picks a free one. */
  port: number;
  /** WebSocket ping interval after handshake. Defaults to 30 s (Cloudflare idle limit is ~100 s). */
  pingIntervalMs?: number;
}

export interface Bridge {
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

/** The bridge only ever listens on loopback; remote access goes through a tunnel. */
const HOST = "127.0.0.1";
/** WebSocket close code for protocol violations (policy violation). */
const CLOSE_PROTOCOL_VIOLATION = 1008;

/**
 * Starts the Bridge Protocol server (see docs/protocol.md): authenticates the
 * upgrade, negotiates the protocol version via `hello`, then keeps the socket
 * alive with pings. Any protocol violation yields an explicit error and closes
 * the socket.
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const { token, port, pingIntervalMs = 30_000 } = options;
  const expected = Buffer.from(`Bearer ${token}`);
  const isAuthorized = (req: IncomingMessage): boolean => {
    const given = Buffer.from(req.headers.authorization ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const http = createServer((req, res) => {
    // Plain HTTP carries no protocol traffic yet; only the upgrade is served.
    res.writeHead(isAuthorized(req) ? 426 : 401).end();
  });
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    if (!isAuthorized(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(ws, pingIntervalMs));
  });

  await new Promise<void>((resolve) => http.listen(port, HOST, resolve));
  const address = http.address() as AddressInfo;

  return {
    host: HOST,
    port: address.port,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Drives one authenticated connection: handshake first, then commands. */
function serve(ws: WebSocket, pingIntervalMs: number): void {
  let pinger: NodeJS.Timeout | undefined;
  let handshaken = false;

  const send = (record: BridgeRecord) => ws.send(encode(record));
  const reject = (record: BridgeRecord) => {
    send(record);
    ws.close(CLOSE_PROTOCOL_VIOLATION);
  };

  const handle = (command: Command): boolean => {
    if (!handshaken) return handshake(command);
    send({
      type: "result",
      id: command.id,
      error: {
        code: "unknownCommand",
        message: `unknown command "${command.name}"`,
      },
    });
    return true;
  };

  /** Returns false if the connection was rejected. */
  const handshake = ({ id, name, params }: Command): boolean => {
    if (name !== "hello") {
      reject({
        type: "error",
        error: {
          code: "helloRequired",
          message: "first command must be hello",
        },
      });
      return false;
    }
    if (!Number.isInteger(params.protocolVersion)) {
      reject({
        type: "error",
        error: {
          code: "malformedRecord",
          message: "hello requires integer params.protocolVersion",
        },
      });
      return false;
    }
    if (params.protocolVersion !== PROTOCOL_VERSION) {
      reject({
        type: "result",
        id,
        error: {
          code: "versionMismatch",
          message: `bridge speaks protocol version ${PROTOCOL_VERSION}`,
        },
      });
      return false;
    }
    handshaken = true;
    send({ type: "result", id, result: { protocolVersion: PROTOCOL_VERSION } });
    pinger = setInterval(() => ws.ping(), pingIntervalMs);
    return true;
  };

  ws.on("message", (data: RawData) => {
    let commands: Command[];
    try {
      commands = parseCommands(data.toString());
    } catch (e) {
      if (!(e instanceof MalformedRecordError)) throw e;
      reject({
        type: "error",
        error: { code: "malformedRecord", message: e.message },
      });
      return;
    }
    for (const command of commands) if (!handle(command)) return;
  });
  ws.on("close", () => clearInterval(pinger));
}
