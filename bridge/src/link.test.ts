import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LinkClient } from "./linkClient.js";
import { listenForShares } from "./linkGateway.js";
import { PiShare, type PiEvent, type PiHost } from "./piShare.js";
import { SessionHub, type BridgeEvent } from "./session.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-link-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function listening(path: string) {
  const hub = new SessionHub();
  const shares = await listenForShares(path, hub);
  cleanups.push(() => shares.close());
  return hub;
}

/** A pi process sharing session `id`, with what the app sent it. */
function pi(id: string, cwd = "/work") {
  const sent: string[] = [];
  const host: PiHost = {
    send: (text) => void sent.push(text),
    abort: () => {},
    hasPendingMessages: () => false,
    branch: () =>
      [
        { type: "message", message: { role: "user", content: `hi ${id}` } },
      ] as SessionEntry[],
    entries: () => [],
    sessionId: () => id,
    sessionName: () => undefined,
    cwd,
    commands: () => [],
    model: () => undefined,
    contextUsage: () => undefined,
    models: () => [],
    setModel: async () => {},
  };
  return { host, sent };
}

function client(path: string, startBridge = () => {}) {
  const link = new LinkClient(path, startBridge);
  cleanups.push(() => link.close());
  return link;
}

function share(link: LinkClient, host: PiHost) {
  const s = new PiShare(host, (record) => link.send(record));
  link.attach(s);
  return s;
}

async function eventually<T>(probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = probe();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

test("a pi session shared over the link is listed, and joined clients drive it and see its events", async () => {
  const path = join(tempDir(), "bridge.sock");
  const hub = await listening(path);
  const { host, sent } = pi("s1");
  const s = share(client(path), host);

  const session = await eventually(() => hub.find("s1"));
  expect(hub.list()).toMatchObject([
    { id: "s1", cwd: "/work", preview: "hi s1", running: false },
  ]);
  const events: BridgeEvent[] = [];
  session.subscribe(0, undefined, (e) => events.push(e));
  await eventually(() => events.length === 1);
  expect(events[0]).toMatchObject({
    name: "transcript",
    data: { messages: [{ role: "user", text: "hi s1" }] },
  });

  await session.prompt("go");
  expect(sent).toEqual(["go"]);
  s.handle({ type: "agent_start" } as PiEvent);
  await eventually(() => events.length === 2);
  expect(events[1]).toMatchObject({ name: "runStarted" });
});

test("when pi replaces its session the share follows it on the same link", async () => {
  const path = join(tempDir(), "bridge.sock");
  const hub = await listening(path);
  const link = client(path);
  const first = share(link, pi("s1").host);
  await eventually(() => hub.find("s1"));

  link.detach(first);
  share(link, pi("s2").host);

  await eventually(() => hub.find("s2"));
  expect(hub.list().map((s) => s.id)).toEqual(["s2"]);
});

test("pi quitting ends its session on the bridge", async () => {
  const path = join(tempDir(), "bridge.sock");
  const hub = await listening(path);
  const link = client(path);
  share(link, pi("s1").host);
  await eventually(() => hub.find("s1"));

  link.close();

  await eventually(() => hub.list().length === 0);
});

test("with no bridge listening, pi starts one and shares once it is up", async () => {
  const path = join(tempDir(), "bridge.sock");
  let hub: SessionHub | undefined;
  let starts = 0;
  const link = client(path, () => {
    if (starts++ === 0) void listening(path).then((h) => (hub = h));
  });
  share(link, pi("s1").host);

  await eventually(() => hub?.find("s1"));
  expect(starts).toBeGreaterThanOrEqual(1);
});

test("the socket is private to the user and replaces a leftover file", async () => {
  const path = join(tempDir(), "bridge.sock");
  writeFileSync(path, "stale");

  await listening(path);

  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("pi starting the same session twice announces it once", async () => {
  const path = join(tempDir(), "bridge.sock");
  const hub = await listening(path);
  const link = client(path);
  share(link, pi("s1").host);
  const session = await eventually(() => hub.find("s1"));
  const events: BridgeEvent[] = [];
  session.subscribe(0, undefined, (e) => events.push(e));
  await eventually(() => events.length === 1);

  share(link, pi("s1").host);
  share(link, pi("s1").host).handle({ type: "agent_start" } as PiEvent);

  await eventually(() => events.length === 2);
  expect(events.map((e) => e.name)).toEqual(["transcript", "runStarted"]);
});

test("a snapshot covers exactly the events pi sent before its history, even when both arrive in one chunk", async () => {
  const path = join(tempDir(), "bridge.sock");
  const hub = await listening(path);
  const raw = connect(path);
  cleanups.push(() => void raw.destroy());
  raw.setEncoding("utf8");
  const calls: string[] = [];
  raw.on("data", (chunk: string) =>
    calls.push(...chunk.split("\n").filter(Boolean))
  );
  const info = { id: "s1", cwd: "/work", preview: "" };
  raw.write(JSON.stringify({ type: "announce", info }) + "\n");
  const session = await eventually(() => hub.find("s1"));
  const events: BridgeEvent[] = [];
  session.subscribe(0, undefined, (e) => events.push(e));
  const { id } = JSON.parse(await eventually(() => calls[0]));

  raw.write(
    [
      {
        type: "reply",
        id,
        result: { messages: [], steering: [], followUp: [] },
      },
      { type: "event", event: { name: "userMessage", text: "later" } },
    ]
      .map((r) => JSON.stringify(r) + "\n")
      .join("")
  );

  await eventually(() => events.length === 2);
  expect(events).toMatchObject([
    { seq: 0, name: "transcript", data: { messages: [] } },
    { seq: 1, name: "userMessage", data: { text: "later" } },
  ]);
});

test("a call pi answers asynchronously resolves once pi is done", async () => {
  const path = join(tempDir(), "bridge.sock");
  const hub = await listening(path);
  const { host } = pi("s1");
  let finish: (() => void) | undefined;
  host.setModel = () => new Promise<void>((resolve) => (finish = resolve));
  share(client(path), host);
  const session = await eventually(() => hub.find("s1"));
  let done = false;

  const switched = session.setModel("anthropic", "opus").then(() => {
    done = true;
  });
  await eventually(() => finish);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done).toBe(false);
  finish!();

  await switched;
});

test("pi gets the pairing URL from the bridge, before sharing any session", async () => {
  const path = join(tempDir(), "bridge.sock");
  const shares = await listenForShares(path, new SessionHub(), {
    pairingUrl: () => "pimobile://connect?token=t",
  });
  cleanups.push(() => shares.close());
  expect(await client(path).pairingUrl()).toBe("pimobile://connect?token=t");
});

test("asking for the pairing URL fails without a bridge or without a public URL", async () => {
  const path = join(tempDir(), "bridge.sock");
  await expect(client(path).pairingUrl(100)).rejects.toThrow(
    "bridge is not running"
  );
  await listening(path);
  await expect(client(path).pairingUrl()).rejects.toThrow("publicUrl");
});
