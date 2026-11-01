import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { LinkClient } from "./linkClient.js";
import { listenForShares } from "./linkGateway.js";
import type { RunNotifier, SettledRun } from "./ntfy.js";
import { PiShare, type PiEvent, type PiHost } from "./piShare.js";
import { PrintRun } from "./printRun.js";
import { CommandError } from "./protocol.js";
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

async function listening(path: string, notifier?: RunNotifier) {
  const hub = new SessionHub(undefined, notifier);
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
    isIdle: () => true,
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
    thinkingLevel: () => "off",
    thinkingLevels: () => ["off"],
    setThinkingLevel: () => {},
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

  await session.gateway.call("prompt", "go");
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

  const switched = session.gateway
    .call("setModel", "anthropic", "opus")
    .then(() => {
      done = true;
    });
  await eventually(() => finish);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(done).toBe(false);
  finish!();

  await switched;
});

test("pi refusing a call for a known reason keeps its code across the link", async () => {
  const path = join(tempDir(), "bridge.sock");
  const hub = await listening(path);
  const { host } = pi("s1");
  host.isIdle = () => false;
  share(client(path), host);
  const session = await eventually(() => hub.find("s1"));

  const refusal = session.gateway.call("prompt", "ambiguous");

  await expect(refusal).rejects.toBeInstanceOf(CommandError);
  await expect(refusal).rejects.toMatchObject({ code: "runActive" });
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

/** A notifier recording the runs that settle, to observe what the bridge knows about them. */
function recording() {
  const runs: SettledRun[] = [];
  const notifier: RunNotifier = { runSettled: (run) => void runs.push(run) };
  return { runs, notifier };
}

const runSettles = (share: PiShare) => {
  share.handle({ type: "agent_start" } as PiEvent);
  share.handle({ type: "agent_settled" } as PiEvent);
};

test("the terminal's focus reaches the rule of the session's settled runs", async () => {
  const path = join(tempDir(), "bridge.sock");
  const { runs, notifier } = recording();
  const hub = await listening(path, notifier);
  const link = client(path);
  const s = share(link, pi("s1").host);
  await eventually(() => hub.find("s1"));

  runSettles(s);
  await eventually(() => runs.length === 1);
  link.setFocus(true);
  await eventually(() => hub.find("s1")?.gateway.terminalFocused());
  runSettles(s);
  await eventually(() => runs.length === 2);
  link.setFocus(false);
  await eventually(() => hub.find("s1")?.gateway.terminalFocused() === false);
  runSettles(s);
  await eventually(() => runs.length === 3);

  expect(runs.map((run) => run.focused)).toEqual([undefined, true, false]);
});

test("the terminal's focus carries over when pi replaces its session", async () => {
  const path = join(tempDir(), "bridge.sock");
  const { runs, notifier } = recording();
  const hub = await listening(path, notifier);
  const link = client(path);
  const first = share(link, pi("s1").host);
  await eventually(() => hub.find("s1"));
  link.setFocus(true);
  await eventually(() => hub.find("s1")?.gateway.terminalFocused());

  link.detach(first);
  const second = share(link, pi("s2").host);
  await eventually(() => hub.find("s2"));
  runSettles(second);

  await eventually(() => runs.length === 1);
  expect(runs[0]).toMatchObject({ sessionId: "s2", focused: true });
});

test("focus reported before the session is shared counts once it is", async () => {
  const path = join(tempDir(), "bridge.sock");
  const { runs, notifier } = recording();
  const hub = await listening(path, notifier);
  const link = client(path);
  link.setFocus(true);

  const s = share(link, pi("s1").host);
  await eventually(() => hub.find("s1"));
  runSettles(s);

  await eventually(() => runs.length === 1);
  expect(runs[0]).toMatchObject({ focused: true });
});

/** Resolves once `link` reached the bridge (asking for the pairing URL waits for that). */
const connected = (link: LinkClient) => link.pairingUrl().catch(() => {});

/** A `pi -p` process: no shared session, only what its runs report. */
function printPi(link: LinkClient, id = "p1", name?: string) {
  return new PrintRun(
    { sessionId: () => id, sessionName: () => name, cwd: "/work/leaf" },
    (record) => link.send(record)
  );
}

const answered = (text: string, stopReason = "stop", errorMessage?: string) =>
  ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      errorMessage,
    },
  }) as PiEvent;

/** Pi's events for one print-mode run that ends with `last`. */
const printRun = (run: PrintRun, last: PiEvent, aborted = false) => {
  run.handle({ type: "agent_start" } as PiEvent);
  run.handle(answered("first"));
  run.handle(last);
  run.handle({ type: "agent_settled", aborted } as PiEvent);
};

test("a settled print-mode run is reported without being listed", async () => {
  const path = join(tempDir(), "bridge.sock");
  const { runs, notifier } = recording();
  const hub = await listening(path, notifier);
  const link = client(path);
  await connected(link);

  printRun(printPi(link, "p1", "nightly"), answered("All done."));

  await eventually(() => runs.length === 1);
  expect(runs[0]).toEqual({
    sessionId: "p1",
    cwd: "/work/leaf",
    sessionName: "nightly",
    stopReason: "success",
    lastText: "All done.",
    listed: false,
    joined: false,
  });
  expect(hub.list()).toEqual([]);
});

test("a print-mode run that fails reports its error", async () => {
  const path = join(tempDir(), "bridge.sock");
  const { runs, notifier } = recording();
  await listening(path, notifier);
  const link = client(path);
  await connected(link);

  printRun(printPi(link), answered("", "error", "rate limited"));

  await eventually(() => runs.length === 1);
  expect(runs[0]).toMatchObject({
    stopReason: "error",
    errorMessage: "rate limited",
    lastText: "first",
  });
});

test("an aborted print-mode run is not reported, the next one is", async () => {
  const path = join(tempDir(), "bridge.sock");
  const { runs, notifier } = recording();
  await listening(path, notifier);
  const link = client(path);
  await connected(link);
  const run = printPi(link);

  printRun(run, answered("", "aborted"), true);
  printRun(run, answered("again"));

  await eventually(() => runs.length === 1);
  expect(runs[0]).toMatchObject({ lastText: "again" });
});

test("a print-mode pi that exits right after its run still delivers the report", async () => {
  const path = join(tempDir(), "bridge.sock");
  const { runs, notifier } = recording();
  await listening(path, notifier);
  const link = client(path);
  await connected(link);

  printRun(printPi(link), answered("bye"));
  await link.flush();
  link.close();

  await eventually(() => runs.length === 1);
});

test("with no bridge, flushing returns at once", async () => {
  const link = client(join(tempDir(), "bridge.sock"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const started = Date.now();

  await link.flush();

  expect(Date.now() - started).toBeLessThan(200);
});
