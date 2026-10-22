import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";
import { FakeGateway } from "./fakeGateway.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { startBridge, type Bridge } from "./server.js";

const TOKEN = "s3cret";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function bridge(
  pingIntervalMs?: number,
  gateway = new FakeGateway()
): Promise<Bridge> {
  const b = await startBridge({
    token: TOKEN,
    port: 0,
    pingIntervalMs,
    gateway,
  });
  cleanups.push(() => b.close());
  return b;
}

/** A real WebSocket client that queues incoming records and records the close. */
async function connect(b: Bridge, token: string | null = TOKEN) {
  const headers = token === null ? {} : { Authorization: `Bearer ${token}` };
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}`, { headers });
  cleanups.push(() => ws.terminate());
  const records: unknown[] = [];
  const waiting: Array<() => void> = [];
  ws.on("message", (data) => {
    for (const line of data.toString().split("\n")) {
      if (line) records.push(JSON.parse(line));
    }
    waiting.splice(0).forEach((wake) => wake());
  });
  const closed = new Promise<number>((resolve) =>
    ws.on("close", (code) => resolve(code))
  );
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    closed,
    send: (text: string) => ws.send(text),
    async next(): Promise<unknown> {
      while (records.length === 0)
        await new Promise<void>((wake) => waiting.push(wake));
      return records.shift();
    },
  };
}

const hello = (id: number, protocolVersion: number) =>
  JSON.stringify({
    type: "command",
    id,
    name: "hello",
    params: { protocolVersion, lastSeq: 0 },
  }) + "\n";

test("valid token and supported version are acked, then pinged", async () => {
  const b = await bridge(20);
  const c = await connect(b);
  const pinged = new Promise<void>((resolve) => c.ws.once("ping", resolve));

  c.send(hello(1, PROTOCOL_VERSION));

  expect(await c.next()).toEqual({
    type: "result",
    id: 1,
    result: { protocolVersion: PROTOCOL_VERSION },
  });
  await pinged;
});

test("no pings are sent before the handshake completes", async () => {
  const b = await bridge(10);
  const c = await connect(b);
  let pinged = false;
  c.ws.on("ping", () => (pinged = true));

  await new Promise((resolve) => setTimeout(resolve, 60));

  expect(pinged).toBe(false);
});

test.each([
  ["wrong token", "nope"],
  ["missing token", null],
])("%s is rejected at upgrade with 401", async (_name, token) => {
  const b = await bridge();
  const err = await connect(b, token).then(
    () => null,
    (e: Error) => e
  );
  expect(err?.message).toBe("Unexpected server response: 401");
});

test("unsupported protocol version yields versionMismatch and close", async () => {
  const b = await bridge();
  const c = await connect(b);

  c.send(hello(7, PROTOCOL_VERSION + 1));

  expect(await c.next()).toMatchObject({
    type: "result",
    id: 7,
    error: { code: "versionMismatch" },
  });
  expect(await c.closed).toBe(1008);
});

test.each([
  ["non-JSON", "not json\n"],
  ["non-object JSON", "[1,2]\n"],
  ["wrong shape", JSON.stringify({ type: "command", name: "hello" }) + "\n"],
  [
    "hello without protocolVersion",
    JSON.stringify({ type: "command", id: 1, name: "hello", params: {} }) +
      "\n",
  ],
])(
  "malformed record (%s) yields malformedRecord and close",
  async (_n, raw) => {
    const b = await bridge();
    const c = await connect(b);

    c.send(raw);

    expect(await c.next()).toMatchObject({
      type: "error",
      error: { code: "malformedRecord" },
    });
    expect(await c.closed).toBe(1008);
  }
);

test("a command before hello yields helloRequired and close", async () => {
  const b = await bridge();
  const c = await connect(b);

  c.send(
    JSON.stringify({ type: "command", id: 1, name: "abort", params: {} }) + "\n"
  );

  expect(await c.next()).toMatchObject({
    type: "error",
    error: { code: "helloRequired" },
  });
  expect(await c.closed).toBe(1008);
});

test("one frame may carry several records", async () => {
  const b = await bridge();
  const c = await connect(b);

  c.send(
    hello(1, PROTOCOL_VERSION) +
      JSON.stringify({ type: "command", id: 2, name: "bogus", params: {} }) +
      "\n"
  );

  expect(await c.next()).toMatchObject({ id: 1, result: expect.anything() });
  expect(await c.next()).toEqual({
    type: "result",
    id: 2,
    error: { code: "unknownCommand", message: expect.any(String) },
  });
});

test("binds to localhost only", async () => {
  const b = await bridge();
  expect(b.host).toBe("127.0.0.1");
});

/** Connects and completes the handshake, leaving the connection ready for commands. */
async function ready(b: Bridge) {
  const c = await connect(b);
  c.send(hello(1, PROTOCOL_VERSION));
  await c.next();
  return c;
}

const command = (id: number, name: string, params: object) =>
  JSON.stringify({ type: "command", id, name, params }) + "\n";

test("a prompt streams deltas, message end and run settled in order", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "prompt", { text: "hi" }));
  expect(await c.next()).toEqual({ type: "result", id: 2, result: {} });
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "delta", kind: "thinking", text: "hmm" });
  gateway.emit({ name: "delta", kind: "text", text: "Hel" });
  gateway.emit({ name: "delta", kind: "text", text: "lo" });
  gateway.emit({ name: "messageEnd", text: "Hello", thinking: "hmm" });
  gateway.emit({ name: "runSettled", stopReason: "success" });

  const events = [];
  for (let i = 0; i < 6; i++) events.push(await c.next());
  expect(events).toEqual([
    { type: "event", seq: 1, name: "runStarted", data: {} },
    {
      type: "event",
      seq: 2,
      name: "delta",
      data: { kind: "thinking", text: "hmm" },
    },
    {
      type: "event",
      seq: 3,
      name: "delta",
      data: { kind: "text", text: "Hel" },
    },
    {
      type: "event",
      seq: 4,
      name: "delta",
      data: { kind: "text", text: "lo" },
    },
    {
      type: "event",
      seq: 5,
      name: "messageEnd",
      data: { text: "Hello", thinking: "hmm" },
    },
    {
      type: "event",
      seq: 6,
      name: "runSettled",
      data: { stopReason: "success", durationMs: expect.any(Number) },
    },
  ]);
  expect(gateway.prompts).toEqual(["hi"]);
});

test.each([
  ["success", undefined],
  ["error", "provider exploded"],
  ["aborted", undefined],
] as const)(
  "run settled carries stop reason %s and the run's duration",
  async (stopReason, errorMessage) => {
    const gateway = new FakeGateway();
    const c = await ready(await bridge(undefined, gateway));

    gateway.emit({ name: "runStarted" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    gateway.emit({ name: "runSettled", stopReason, errorMessage });

    await c.next(); // runStarted
    const settled = (await c.next()) as {
      data: { stopReason: string; durationMs: number; errorMessage?: string };
    };
    expect(settled.data.stopReason).toBe(stopReason);
    expect(settled.data.errorMessage).toBe(errorMessage);
    expect(settled.data.durationMs).toBeGreaterThanOrEqual(25);
    expect(settled.data.durationMs).toBeLessThan(1000);
  }
);

test("during a run, a prompt routes as steer or follow-up per its mode", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));
  c.send(command(2, "prompt", { text: "go" }));
  await c.next();
  gateway.emit({ name: "runStarted" });
  await c.next();

  c.send(command(3, "prompt", { text: "left", mode: "steer" }));
  c.send(command(4, "prompt", { text: "later", mode: "followUp" }));
  expect(await c.next()).toEqual({ type: "result", id: 3, result: {} });
  expect(await c.next()).toEqual({ type: "result", id: 4, result: {} });

  expect(gateway.prompts).toEqual(["go"]);
  expect(gateway.steers).toEqual(["left"]);
  expect(gateway.followUps).toEqual(["later"]);
});

test("during a run, a prompt without a mode is refused", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));
  gateway.emit({ name: "runStarted" });
  await c.next();

  c.send(command(2, "prompt", { text: "ambiguous" }));

  expect(await c.next()).toMatchObject({
    type: "result",
    id: 2,
    error: { code: "runActive" },
  });
  expect(gateway.prompts).toEqual([]);
});

test("once a run has settled, a prompt starts a new run even with a mode", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "runSettled", stopReason: "success" });
  await c.next();
  await c.next();

  c.send(command(2, "prompt", { text: "again", mode: "steer" }));
  await c.next();

  expect(gateway.prompts).toEqual(["again"]);
  expect(gateway.steers).toEqual([]);
});

test("a gateway failure becomes an error result and the connection stays usable", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));
  gateway.failNextWith = new Error("no model configured");

  c.send(command(2, "prompt", { text: "hi" }));
  expect(await c.next()).toEqual({
    type: "result",
    id: 2,
    error: { code: "sessionError", message: "no model configured" },
  });

  c.send(command(3, "prompt", { text: "retry" }));
  expect(await c.next()).toEqual({ type: "result", id: 3, result: {} });
});

test.each([
  ["missing text", {}],
  ["non-string text", { text: 5 }],
  ["unknown mode", { text: "x", mode: "shout" }],
])("prompt with %s yields invalidParams", async (_n, params) => {
  const c = await ready(await bridge());

  c.send(command(2, "prompt", params));

  expect(await c.next()).toMatchObject({
    type: "result",
    id: 2,
    error: { code: "invalidParams" },
  });
});
