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
import { NtfyNotifier, type NtfyConfig } from "./ntfy.js";
import { CommandError, SessionHub, type Session } from "./session.js";

export interface BridgeOptions {
  /** Bearer token every request and WebSocket upgrade must present. */
  token: string;
  /** TCP port on localhost; 0 picks a free one. */
  port: number;
  /** WebSocket ping interval after handshake. Defaults to 30 s (Cloudflare idle limit is ~100 s). */
  pingIntervalMs?: number;
  /** Events kept per session for replay on rejoin; older cursors get a snapshot. Defaults to 1000. */
  replayLimit?: number;
  /** When set, every settled run is announced on this ntfy topic. */
  ntfy?: NtfyConfig;
}

export interface Bridge {
  readonly host: string;
  readonly port: number;
  /** The shared pi sessions the bridge serves; pi links register here. */
  readonly hub: SessionHub;
  close(): Promise<void>;
}

/** The bridge only ever listens on loopback; remote access goes through a tunnel. */
const HOST = "127.0.0.1";
/** `searchFiles` result size when the app names none, and the most it may ask for. */
const DEFAULT_FILE_LIMIT = 20;
const MAX_FILE_LIMIT = 100;
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
  const { token, port, pingIntervalMs = 30_000, replayLimit, ntfy } = options;
  const hub = new SessionHub(replayLimit, ntfy && new NtfyNotifier(ntfy));
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
      serve(ws, pingIntervalMs, hub, ntfy)
    );
  });

  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, HOST, resolve);
  });
  const address = http.address() as AddressInfo;

  return {
    host: HOST,
    port: address.port,
    hub,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      hub.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/**
 * Drives one authenticated connection: handshake first, then commands. The
 * connection is joined to at most one session, which its events and
 * session commands concern.
 */
function serve(
  ws: WebSocket,
  pingIntervalMs: number,
  hub: SessionHub,
  ntfy: NtfyConfig | undefined
): void {
  let pinger: NodeJS.Timeout | undefined;
  let handshaken = false;
  let joined: { session: Session; leave: () => void } | undefined;
  const leave = () => {
    joined?.leave();
    joined = undefined;
  };
  /** The joined session, for commands that need one. */
  const joinedSession = (): Session => {
    if (!joined) throw new CommandError("notJoined", "join a session first");
    return joined.session;
  };

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
    /** Replies with `action`'s result, or with its failure; the connection stays usable. */
    const respond = async (action: () => Promise<unknown>) => {
      try {
        reply({ result: await action() });
      } catch (e) {
        reply({
          error:
            e instanceof CommandError
              ? { code: e.code, message: e.message }
              : { code: "sessionError", message: errorMessage(e) },
        });
      }
    };
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
        await respond(async () => {
          await joinedSession().prompt(text, mode);
          return {};
        });
        break;
      }
      case "abort":
        await respond(async () => {
          await joinedSession().abort();
          return {};
        });
        break;
      case "getSessions":
        await respond(async () => ({
          sessions: hub.list(),
          ...(joined && { joinedId: joined.session.id }),
        }));
        break;
      case "joinSession": {
        const { id: sessionId, lastSeq, epoch } = params;
        if (typeof sessionId !== "string") {
          reply({
            error: {
              code: "invalidParams",
              message: "joinSession requires string id",
            },
          });
          break;
        }
        const session = hub.find(sessionId);
        if (!session) {
          reply({
            error: {
              code: "unknownSession",
              message: `no live session with id "${sessionId}"`,
            },
          });
          break;
        }
        leave();
        reply({ result: { epoch: session.epoch } });
        // A missing or invalid cursor means "nothing seen": a snapshot is always safe.
        const cursor = Number.isInteger(lastSeq) ? (lastSeq as number) : 0;
        const unsubscribe = session.subscribe(cursor, epoch, (event) => {
          send({ type: "event", ...event });
          if (event.name === "sessionEnded") joined = undefined;
        });
        joined = { session, leave: unsubscribe };
        break;
      }
      case "getStats":
        await respond(() => joinedSession().stats());
        break;
      case "listSkills":
        await respond(async () => ({ skills: await joinedSession().skills() }));
        break;
      case "listModels":
        await respond(async () => ({ models: await joinedSession().models() }));
        break;
      case "setModel": {
        const { provider, id: modelId } = params;
        if (typeof provider !== "string" || typeof modelId !== "string") {
          reply({
            error: {
              code: "invalidParams",
              message: "setModel requires string provider and id",
            },
          });
          break;
        }
        await respond(async () => {
          await joinedSession().setModel(provider, modelId);
          return {};
        });
        break;
      }
      case "searchFiles": {
        const { query, limit = DEFAULT_FILE_LIMIT } = params;
        if (
          typeof query !== "string" ||
          typeof limit !== "number" ||
          !Number.isInteger(limit) ||
          limit < 1
        ) {
          reply({
            error: {
              code: "invalidParams",
              message:
                "searchFiles requires string query and positive integer limit",
            },
          });
          break;
        }
        await respond(async () => ({
          files: await joinedSession().searchFiles(
            query,
            Math.min(limit, MAX_FILE_LIMIT)
          ),
        }));
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
    send({
      type: "result",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        ...(ntfy && { ntfy }),
      },
    });
    pinger = setInterval(() => ws.ping(), pingIntervalMs);
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
    leave();
  });
}

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
