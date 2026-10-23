import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type {
  GatewayEvent,
  SessionGateway,
  SessionHistory,
  SharedSessionInfo,
} from "./gateway.js";
import { searchWorkspace } from "./fileSearch.js";
import {
  readRecords,
  write,
  type Call,
  type CallResults,
  type ShareRecord,
} from "./link.js";

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

  prompt = (text: string) => this.call({ method: "prompt", text });
  steer = (text: string) => this.call({ method: "steer", text });
  followUp = (text: string) => this.call({ method: "followUp", text });
  abort = () => this.call({ method: "abort" });
  skills = () => this.call({ method: "skills" });
  stats = () => this.call({ method: "stats" });
  models = () => this.call({ method: "models" });
  setModel = (provider: string, id: string) =>
    this.call({ method: "setModel", provider, modelId: id });

  history(onHistory: (history: SessionHistory | undefined) => void): void {
    // Not via `call`: resolving a Promise would run `onHistory` only after
    // later records of the same chunk had been emitted.
    this.send({ method: "history" }, (result, error) =>
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
        break;
      case "event":
        this.emit(record.event);
        break;
      case "reply": {
        const onReply = this.pending.get(record.id);
        this.pending.delete(record.id);
        onReply?.(
          record.result,
          record.error === undefined ? undefined : new Error(record.error)
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

  private call<M extends Call["method"]>(
    call: Call & { method: M }
  ): Promise<CallResults[M]> {
    return new Promise((resolve, reject) =>
      this.send(call, (result, error) =>
        error ? reject(error) : resolve(result as CallResults[M])
      )
    );
  }

  private send(
    call: Call,
    onReply: (result: unknown, error?: Error) => void
  ): void {
    const id = this.nextId++;
    this.pending.set(id, onReply);
    write(this.socket, { type: "call", id, ...call });
  }

  private emit(event: GatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

/** Where shared sessions come and go. */
export interface ShareRegistry<Handle> {
  add(gateway: SessionGateway): Handle;
  remove(handle: Handle): void;
}

/**
 * Accepts Share Links on the unix socket `path`, registering each pi session
 * with `registry` on its first `announce` and removing it when the link drops.
 * Replaces a leftover socket file: the caller must already know no other
 * bridge is running.
 */
export async function listenForShares<Handle>(
  path: string,
  registry: ShareRegistry<Handle>
): Promise<{ close(): Promise<void> }> {
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let gateway: LinkGateway | undefined;
    let handle: Handle | undefined;
    readRecords<ShareRecord>(socket, (record) => {
      if (gateway) return gateway.receive(record);
      if (record.type !== "announce") return;
      gateway = new LinkGateway(socket, record.info);
      handle = registry.add(gateway);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      gateway?.close();
      if (handle !== undefined) registry.remove(handle);
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
