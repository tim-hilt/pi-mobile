import { connect, type Socket } from "node:net";
import {
  readRecords,
  write,
  type CallRecord,
  type ShareRecord,
} from "./link.js";
import type { PiShare } from "./piShare.js";

/** Reconnect delays: start fast (a bridge we just spawned is coming up), back off to this. */
const FIRST_RETRY_MS = 200;
const MAX_RETRY_MS = 5_000;

/**
 * The pi side of the Share Link: keeps one connection to the bridge for the
 * whole pi process and shares whichever session is attached, re-announcing it
 * on every (re)connect. While no bridge answers it calls `startBridge` and
 * retries; it never surfaces errors to pi.
 */
export class LinkClient {
  private socket: Socket | undefined;
  private connected = false;
  private share: PiShare | undefined;
  /** The session the bridge last heard announced on this connection. */
  private announced: string | undefined;
  private retryMs = FIRST_RETRY_MS;
  private retry: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private path: string,
    private startBridge: () => void
  ) {
    this.connect();
  }

  /**
   * Shares `share` from now on, replacing the previous session (pi switched
   * sessions). Announces it unless the bridge already knows it: pi may start
   * the same session more than once.
   */
  attach(share: PiShare): void {
    this.share = share;
    if (!this.connected || share.info().id === this.announced) return;
    this.announced = share.info().id;
    for (const record of share.introduction()) this.send(record);
  }

  /** Stops sharing `share`; the bridge keeps the link until another session is attached. */
  detach(share: PiShare): void {
    if (this.share === share) this.share = undefined;
  }

  /** What an attached share emits. Dropped while disconnected: a reconnect re-announces. */
  send(record: ShareRecord): void {
    if (this.connected && this.socket) write(this.socket, record);
  }

  /** Pi is quitting: ends the link for good, so the bridge drops the session. */
  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.socket?.destroy();
  }

  private connect(): void {
    const socket = connect(this.path);
    this.socket = socket;
    // The link must never keep pi alive.
    socket.unref();
    socket.on("connect", () => {
      this.connected = true;
      this.retryMs = FIRST_RETRY_MS;
      if (this.share) this.attach(this.share);
    });
    readRecords<CallRecord>(socket, (call) => this.answer(socket, call));
    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") this.startBridge();
    });
    socket.on("close", () => {
      this.connected = false;
      this.announced = undefined;
      if (this.closed) return;
      this.retry = setTimeout(() => this.connect(), this.retryMs);
      this.retry.unref();
      this.retryMs = Math.min(this.retryMs * 2, MAX_RETRY_MS);
    });
  }

  private answer(socket: Socket, { id, type: _, ...call }: CallRecord): void {
    const share = this.share;
    if (!share) {
      write(socket, { type: "reply", id, error: "pi is switching sessions" });
      return;
    }
    let reply: ShareRecord;
    try {
      reply = { type: "reply", id, result: share.call(call) };
    } catch (e) {
      reply = {
        type: "reply",
        id,
        error: e instanceof Error ? e.message : String(e),
      };
    }
    write(socket, reply);
  }
}
