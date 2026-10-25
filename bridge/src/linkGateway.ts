import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type {
  CallMethod,
  GatewayEvent,
  SessionGateway,
  SessionHistory,
  SharedSessionInfo,
  ShareCalls,
} from "./gateway.js";
import { searchWorkspace } from "./fileSearch.js";
import { readRecords, write, type ShareRecord } from "./link.js";
import { CommandError } from "./protocol.js";
import type { SessionHub } from "./session.js";

/**
 * `SessionGateway` for a pi process on the other end of a Share Link. Calls go
 * over the link and resolve with pi's reply; since the link is ordered, a
 * `history` reply reflects exactly the events received before it. File
 * search runs here: pi shares the machine, so its `cwd` is ours too.
 */
export class LinkGateway implements SessionGateway {
  private listeners = new Set<(event: GatewayEvent) => void>();
  /** Calls awaiting pi's reply, by id; invoked as soon as the reply is read. */
  private pending = new Map<number, (result: unknown, error?: Error) => void>();
  private nextId = 1;

  constructor(
    private socket: Socket,
    private current: SharedSessionInfo
  ) {}

  call<M extends CallMethod>(
    method: M,
    ...args: Parameters<ShareCalls[M]>
  ): Promise<Awaited<ReturnType<ShareCalls[M]>>> {
    return new Promise((resolve, reject) =>
      this.send(method, args, (result, error) =>
        error
          ? reject(error)
          : resolve(result as Awaited<ReturnType<ShareCalls[M]>>)
      )
    );
  }

  history(onHistory: (history: SessionHistory | undefined) => void): void {
    // Not via `call`: resolving a Promise would run `onHistory` only after
    // later records of the same chunk had been emitted.
    this.send("history", [], (result, error) =>
      onHistory(error ? undefined : (result as SessionHistory))
    );
  }

  searchFiles(query: string, limit: number): Promise<string[]> {
    return searchWorkspace(this.current.cwd, query, limit);
  }

  info(): SharedSessionInfo {
    return this.current;
  }

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Handles a record pi sent after its first `announce`. */
  receive(record: ShareRecord): void {
    switch (record.type) {
      case "announce":
        this.current = record.info;
        this.emit({ name: "sessionChanged" });
        break;
      case "info":
        this.current = record.info;
        this.emit({ name: "infoChanged" });
        break;
      case "event":
        this.emit(record.event);
        break;
      case "reply": {
        const onReply = this.pending.get(record.id);
        this.pending.delete(record.id);
        if (record.error === undefined) return onReply?.(record.result);
        onReply?.(
          undefined,
          record.code
            ? new CommandError(record.code, record.error)
            : new Error(record.error)
        );
      }
    }
  }

  /** The link is gone: calls still waiting for pi fail. */
  close(): void {
    for (const onReply of this.pending.values())
      onReply(undefined, new Error("the pi session ended"));
    this.pending.clear();
    this.listeners.clear();
  }

  private send(
    method: keyof ShareCalls,
    args: unknown[],
    onReply: (result: unknown, error?: Error) => void
  ): void {
    const id = this.nextId++;
    this.pending.set(id, onReply);
    write(this.socket, { type: "call", id, method, args });
  }

  private emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/**
 * Accepts Share Links on the unix socket `path`, adding each pi session to
 * `hub` on its first `announce` and removing it when the link drops.
 * Answers `pairing` with `pairingUrl()`, so pi can show the QR code; the token
 * in it never leaves the user's private socket. Replaces a leftover socket
 * file: the caller must already know no other bridge is running.
 */
export async function listenForShares(
  path: string,
  hub: SessionHub,
  {
    pairingUrl = () => undefined,
  }: { pairingUrl?: () => string | undefined } = {}
): Promise<{ close(): Promise<void> }> {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let gateway: LinkGateway | undefined;
    let session: ReturnType<SessionHub["add"]> | undefined;
    readRecords<ShareRecord>(socket, (record) => {
      if (record.type === "pairing") {
        const url = pairingUrl();
        return void write(socket, {
          type: "pairing",
          ...(url
            ? { url }
            : {
                error:
                  "set publicUrl in ~/.pi/agent/bridge.json and restart the bridge",
              }),
        });
      }
      if (gateway) return gateway.receive(record);
      if (record.type !== "announce") return;
      gateway = new LinkGateway(socket, record.info);
      session = hub.add(gateway);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      gateway?.close();
      if (session) hub.remove(session);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  chmodSync(path, 0o600);
  return {
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
