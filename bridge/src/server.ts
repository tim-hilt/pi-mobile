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
  type ProtocolError,
} from "./protocol.js";
import type { SessionGateway } from "./gateway.js";
import { CommandError, Session } from "./session.js";

export interface BridgeOptions {
  /** Bearer token every request and WebSocket upgrade must present. */
  token: string;
  /** TCP port on localhost; 0 picks a free one. */
  port: number;
  /** WebSocket ping interval after handshake. Defaults to 30 s (Cloudflare idle limit is ~100 s). */
  pingIntervalMs?: number;
  /** Events kept for replay on reconnect; older cursors get a snapshot. Defaults to 1000. */
  replayLimit?: number;
  /** The agent session this bridge exposes. */
  gateway: SessionGateway;
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
/** WebSocket close code for an unexpected bridge failure. */
const CLOSE_INTERNAL_ERROR = 1011;

/**
 * Starts the Bridge Protocol server (see docs/protocol.md): authenticates the
 * upgrade, negotiates the protocol version via `hello`, then keeps the socket
 * alive with pings. Any protocol violation yields an explicit error and closes
 * the socket.
 */
export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const {
    token,
    port,
    pingIntervalMs = 30_000,
    gateway,
    replayLimit,
  } = options;
  const session = new Session(gateway, replayLimit);
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
    wss.handleUpgrade(req, socket, head, (ws) =>
      serve(ws, pingIntervalMs, session)
    );
  });

  await new Promise<void>((resolve) => http.listen(port, HOST, resolve));
  const address = http.address() as AddressInfo;

  return {
    host: HOST,
    port: address.port,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      session.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Drives one authenticated connection: handshake first, then commands. */
function serve(ws: WebSocket, pingIntervalMs: number, session: Session): void {
  let pinger: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;
  let handshaken = false;

  const send = (record: BridgeRecord) => ws.send(encode(record));
  const reject = (record: BridgeRecord) => {
    send(record);
    ws.close(CLOSE_PROTOCOL_VIOLATION);
  };

  /** Returns false if the connection was rejected. */
  const handle = async (command: Command): Promise<boolean> => {
    if (!handshaken) return handshake(command);
    const { id, name, params } = command;
    const reply = (outcome: { result: unknown } | { error: ProtocolError }) =>
      send({ type: "result", id, ...outcome });
    switch (name) {
      case "prompt": {
        const { text, mode } = params;
        if (
          typeof text !== "string" ||
          (mode !== undefined && mode !== "steer" && mode !== "followUp")
        ) {
          reply({
            error: {
              code: "invalidParams",
              message:
                'prompt requires string text and mode "steer" | "followUp"',
            },
          });
          break;
        }
        try {
          await session.prompt(text, mode);
          reply({ result: {} });
        } catch (e) {
          reply({
            error:
              e instanceof CommandError
                ? { code: e.code, message: e.message }
                : { code: "sessionError", message: errorMessage(e) },
          });
        }
        break;
      }
      default:
        reply({
          error: {
            code: "unknownCommand",
            message: `unknown command "${name}"`,
          },
        });
    }
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
    // A missing or invalid cursor means "nothing seen": a full snapshot is always safe.
    const lastSeq = Number.isInteger(params.lastSeq)
      ? (params.lastSeq as number)
      : 0;
    unsubscribe = session.subscribe(lastSeq, (event) =>
      send({ type: "event", ...event })
    );
    return true;
  };

  // Commands run strictly one after another so results keep command order.
  let queue = Promise.resolve();
  ws.on("message", (data: RawData) => {
    queue = queue
      .then(async () => {
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
        for (const command of commands) if (!(await handle(command))) return;
      })
      .catch(() => ws.close(CLOSE_INTERNAL_ERROR));
  });
  ws.on("close", () => {
    clearInterval(pinger);
    unsubscribe?.();
  });
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
