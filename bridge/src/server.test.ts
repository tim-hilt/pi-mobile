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
  gateway = new FakeGateway(),
  replayLimit?: number,
  ntfy?: { baseUrl: string; topic: string }
): Promise<Bridge> {
  const b = await startBridge({
    token: TOKEN,
    port: 0,
    pingIntervalMs,
    gateway,
    replayLimit,
    ntfy,
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

const hello = (id: number, protocolVersion: number, lastSeq = 0) =>
  JSON.stringify({
    type: "command",
    id,
    name: "hello",
    params: { protocolVersion, lastSeq },
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

test("the hello result tells the app where settle notifications are published", async () => {
  const ntfy = { baseUrl: "https://ntfy.example", topic: "xk3-secret" };
  const b = await bridge(undefined, new FakeGateway(), undefined, ntfy);
  const c = await connect(b);

  c.send(hello(1, PROTOCOL_VERSION));

  expect(await c.next()).toEqual({
    type: "result",
    id: 1,
    result: { protocolVersion: PROTOCOL_VERSION, ntfy },
  });
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
  await c.next(); // transcript snapshot
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

/**
 * Connects fresh and completes the handshake (consuming the hello result and
 * the catch-up snapshot), leaving the connection ready for commands.
 */
async function ready(b: Bridge) {
  const c = await connect(b);
  c.send(hello(1, PROTOCOL_VERSION));
  await c.next();
  await c.next();
  return c;
}

/** Connects with a replay cursor; consumes the hello result only. */
async function resume(b: Bridge, lastSeq: number) {
  const c = await connect(b);
  c.send(hello(1, PROTOCOL_VERSION, lastSeq));
  await c.next();
  return c;
}

const wire = (seq: number, name: string, data: object) => ({
  type: "event",
  seq,
  name,
  data,
});

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

test("a tool call goes on the wire as toolCall events keyed by phase", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));

  gateway.emit({
    name: "toolCall",
    phase: "start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
  });
  gateway.emit({
    name: "toolCall",
    phase: "end",
    toolCallId: "t1",
    toolName: "bash",
    output: "a.txt\n",
    isError: false,
    durationMs: 12,
  });

  expect(await c.next()).toEqual({
    type: "event",
    seq: 1,
    name: "toolCall",
    data: {
      phase: "start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    },
  });
  expect(await c.next()).toEqual({
    type: "event",
    seq: 2,
    name: "toolCall",
    data: {
      phase: "end",
      toolCallId: "t1",
      toolName: "bash",
      output: "a.txt\n",
      isError: false,
      durationMs: 12,
    },
  });
});

test.each([
  ["success", undefined],
  ["error", "provider exploded"],
  ["aborted", undefined],
  ["length", undefined],
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

test("a fresh connect gets a transcript snapshot at the current seq", async () => {
  const gateway = new FakeGateway();
  gateway.messages = [
    { role: "user", text: "hi" },
    { role: "assistant", text: "Hello", thinking: "hm" },
  ];
  const b = await bridge(undefined, gateway);
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "runSettled", stopReason: "success" });

  const c = await resume(b, 0);

  expect(await c.next()).toEqual(
    wire(2, "transcript", {
      sessionId: "s1",
      messages: gateway.messages,
      running: false,
      steering: [],
      followUp: [],
    })
  );
});

test("a snapshot taken mid-run includes the message still streaming", async () => {
  const gateway = new FakeGateway();
  gateway.messages = [{ role: "user", text: "hi" }];
  const b = await bridge(undefined, gateway);
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "delta", kind: "thinking", text: "hm" });
  gateway.emit({ name: "delta", kind: "text", text: "Hel" });
  gateway.emit({ name: "delta", kind: "text", text: "lo" });

  const c = await resume(b, 0);
  expect(await c.next()).toEqual(
    wire(4, "transcript", {
      sessionId: "s1",
      messages: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "Hello", thinking: "hm", streaming: true },
      ],
      running: true,
      elapsedMs: expect.any(Number),
      steering: [],
      followUp: [],
    })
  );

  gateway.emit({ name: "messageEnd", text: "Hello!", thinking: "hm" });
  const next = await c.next();
  expect(next).toEqual(
    wire(5, "messageEnd", { text: "Hello!", thinking: "hm" })
  );
});

test("a snapshot taken mid-run says how long the run has been going", async () => {
  const gateway = new FakeGateway();
  const b = await bridge(undefined, gateway);
  gateway.emit({ name: "runStarted" });

  const c = await resume(b, 0);

  expect(await c.next()).toMatchObject({
    name: "transcript",
    data: { running: true, elapsedMs: expect.any(Number) },
  });
});

test("a snapshot taken while idle carries no elapsed time", async () => {
  const b = await bridge();
  const c = await resume(b, 0);

  const snapshot = (await c.next()) as { data: object };
  expect(snapshot.data).not.toHaveProperty("elapsedMs");
});

test("a snapshot never repeats a message that already ended", async () => {
  const gateway = new FakeGateway();
  const b = await bridge(undefined, gateway);
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "delta", kind: "text", text: "Hi" });
  gateway.messages = [{ role: "assistant", text: "Hi", thinking: "" }];
  gateway.emit({ name: "messageEnd", text: "Hi", thinking: "" });

  const c = await resume(b, 0);

  expect(await c.next()).toEqual(
    wire(3, "transcript", {
      sessionId: "s1",
      messages: gateway.messages,
      running: true,
      elapsedMs: expect.any(Number),
      steering: [],
      followUp: [],
    })
  );
});

test("reconnecting with a recent cursor replays exactly the missed events, then goes live", async () => {
  const gateway = new FakeGateway();
  const b = await bridge(undefined, gateway);
  gateway.emit({ name: "runStarted" });
  for (const text of ["a", "b", "c"])
    gateway.emit({ name: "delta", kind: "text", text });

  const c = await resume(b, 2);
  gateway.emit({ name: "delta", kind: "text", text: "d" });

  for (const [seq, text] of [
    [3, "b"],
    [4, "c"],
    [5, "d"],
  ] as const)
    expect(await c.next()).toEqual(wire(seq, "delta", { kind: "text", text }));
});

test("a cursor at the live seq replays nothing", async () => {
  const gateway = new FakeGateway();
  const b = await bridge(undefined, gateway);
  gateway.emit({ name: "runStarted" });

  const c = await resume(b, 1);
  gateway.emit({ name: "runSettled", stopReason: "success" });

  expect(await c.next()).toMatchObject({ seq: 2, name: "runSettled" });
});

test("a cursor older than the replay window gets a snapshot instead", async () => {
  const gateway = new FakeGateway();
  const b = await bridge(undefined, gateway, 2);
  gateway.emit({ name: "runStarted" });
  for (const text of ["a", "b", "c", "d"])
    gateway.emit({ name: "delta", kind: "text", text });

  // Window holds seq 4 and 5: a cursor of 3 is still replayable, 2 is not.
  const recent = await resume(b, 3);
  expect(await recent.next()).toMatchObject({ seq: 4, name: "delta" });

  const stale = await resume(b, 2);
  expect(await stale.next()).toMatchObject({ seq: 5, name: "transcript" });
});

test("a cursor ahead of the bridge (bridge restarted) gets a snapshot", async () => {
  const b = await bridge();

  const c = await resume(b, 40);

  expect(await c.next()).toMatchObject({ seq: 0, name: "transcript" });
});

test("abort stops the active run via the gateway", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));
  gateway.emit({ name: "runStarted" });
  await c.next();

  c.send(command(2, "abort", {}));

  expect(await c.next()).toEqual({ type: "result", id: 2, result: {} });
  expect(gateway.aborts).toBe(1);
});

test("a gateway failure while aborting becomes an error result", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));
  gateway.failNextWith = new Error("stuck");

  c.send(command(2, "abort", {}));

  expect(await c.next()).toEqual({
    type: "result",
    id: 2,
    error: { code: "sessionError", message: "stuck" },
  });
});

test("queue changes stream as events", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));

  gateway.emit({ name: "queue", steering: ["left"], followUp: ["later"] });

  expect(await c.next()).toEqual(
    wire(1, "queue", { steering: ["left"], followUp: ["later"] })
  );
});

test("a snapshot lists the messages still queued", async () => {
  const gateway = new FakeGateway();
  gateway.pending = { steering: ["left"], followUp: ["later"] };
  const c = await resume(await bridge(undefined, gateway), 0);

  expect(await c.next()).toMatchObject({
    name: "transcript",
    data: { steering: ["left"], followUp: ["later"] },
  });
});

test("clearQueue drops every queued message and returns them", async () => {
  const gateway = new FakeGateway();
  gateway.pending = { steering: ["left"], followUp: ["later"] };
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "clearQueue", {}));

  expect(await c.next()).toEqual(
    wire(1, "queue", { steering: [], followUp: [] })
  );
  expect(await c.next()).toEqual({
    type: "result",
    id: 2,
    result: { steering: ["left"], followUp: ["later"] },
  });
  expect(gateway.pending).toEqual({ steering: [], followUp: [] });
});

test("a user message entering the transcript streams as an event", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));

  gateway.emit({ name: "userMessage", text: "hi" });

  expect(await c.next()).toEqual(wire(1, "userMessage", { text: "hi" }));
});

test("listSkills returns the session's skills", async () => {
  const gateway = new FakeGateway();
  gateway.skillList = [
    { name: "tdd", description: "Test-driven development." },
    { name: "pr", description: "Write a PR body." },
  ];
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "listSkills", {}));

  expect(await c.next()).toEqual({
    type: "result",
    id: 2,
    result: { skills: gateway.skillList },
  });
});

test("searchFiles returns matching workspace paths, 20 by default", async () => {
  const gateway = new FakeGateway();
  gateway.files = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
  gateway.files.push("README.md");
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "searchFiles", { query: "src/" }));
  c.send(command(3, "searchFiles", { query: "read", limit: 5 }));

  expect(await c.next()).toEqual({
    type: "result",
    id: 2,
    result: { files: gateway.files.slice(0, 20) },
  });
  expect(await c.next()).toEqual({
    type: "result",
    id: 3,
    result: { files: [] },
  });
  expect(gateway.searches).toEqual([
    ["src/", 20],
    ["read", 5],
  ]);
});

test.each([
  ["missing query", {}],
  ["non-string query", { query: 1 }],
  ["non-positive limit", { query: "a", limit: 0 }],
  ["fractional limit", { query: "a", limit: 1.5 }],
])("searchFiles with %s is invalidParams", async (_name, params) => {
  const c = await ready(await bridge());

  c.send(command(2, "searchFiles", params));

  expect(await c.next()).toMatchObject({
    type: "result",
    id: 2,
    error: { code: "invalidParams" },
  });
});

test("searchFiles clamps limit to 100 and survives a failing search", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "searchFiles", { query: "a", limit: 5000 }));
  await c.next();
  gateway.failNextWith = new Error("disk gone");
  c.send(command(3, "searchFiles", { query: "a" }));

  expect(gateway.searches).toEqual([["a", 100]]);
  expect(await c.next()).toEqual({
    type: "result",
    id: 3,
    error: { code: "sessionError", message: "disk gone" },
  });
});

const summary = (id: string, modifiedAt: string, name?: string) => ({
  id,
  ...(name && { name }),
  preview: `first message of ${id}`,
  modifiedAt,
  messageCount: 4,
});

test("getSessions lists the recent sessions, newest first, and marks the current one", async () => {
  const gateway = new FakeGateway();
  gateway.sessionList = [
    summary("s2", "2025-01-02T00:00:00.000Z", "Refactor"),
    summary("s1", "2025-01-01T00:00:00.000Z"),
  ];
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "getSessions", {}));

  expect(await c.next()).toEqual({
    type: "result",
    id: 2,
    result: { sessions: gateway.sessionList, currentId: "s1" },
  });
});

test("getSessions returns only the 30 most recent sessions", async () => {
  const gateway = new FakeGateway();
  gateway.sessionList = Array.from({ length: 40 }, (_, i) =>
    summary(`s${i}`, "2025-01-01T00:00:00.000Z")
  );
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "getSessions", {}));

  expect(await c.next()).toMatchObject({
    result: { sessions: gateway.sessionList.slice(0, 30) },
  });
});

test("newSession switches every client to an empty transcript of the new session", async () => {
  const gateway = new FakeGateway();
  gateway.messages = [{ role: "user", text: "old" }];
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "newSession", {}));

  expect(await c.next()).toEqual(
    wire(1, "transcript", {
      sessionId: "new-1",
      messages: [],
      running: false,
      steering: [],
      followUp: [],
    })
  );
  expect(await c.next()).toEqual({ type: "result", id: 2, result: {} });
});

test("switchSession shows the target session's transcript and restarts the replay cursor", async () => {
  const gateway = new FakeGateway();
  gateway.sessionList = [
    summary("s1", "2025-01-02T00:00:00.000Z"),
    summary("s2", "2025-01-01T00:00:00.000Z"),
  ];
  gateway.histories.s2 = [{ role: "user", text: "from s2" }];
  const b = await bridge(undefined, gateway);
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "runSettled", stopReason: "success" });
  const c = await resume(b, 0);
  await c.next(); // snapshot of s1 at seq 2

  c.send(command(2, "switchSession", { id: "s2" }));

  expect(await c.next()).toEqual(
    wire(3, "transcript", {
      sessionId: "s2",
      messages: [{ role: "user", text: "from s2" }],
      running: false,
      steering: [],
      followUp: [],
    })
  );
  expect(await c.next()).toEqual({ type: "result", id: 2, result: {} });

  // A client that last saw s1 must not replay across the switch.
  const stale = await resume(b, 2);
  expect(await stale.next()).toMatchObject({
    seq: 3,
    name: "transcript",
    data: { sessionId: "s2" },
  });
  // A client that saw the switch resumes live.
  const current = await resume(b, 3);
  gateway.emit({ name: "userMessage", text: "next" });
  expect(await current.next()).toMatchObject({ seq: 4, name: "userMessage" });
});

test("switching sessions is refused for an unknown id, bad params, or an active run", async () => {
  const gateway = new FakeGateway();
  gateway.sessionList = [summary("s1", "2025-01-01T00:00:00.000Z")];
  const c = await ready(await bridge(undefined, gateway));

  c.send(command(2, "switchSession", { id: "nope" }));
  expect(await c.next()).toMatchObject({
    id: 2,
    error: { code: "unknownSession" },
  });

  c.send(command(3, "switchSession", {}));
  expect(await c.next()).toMatchObject({
    id: 3,
    error: { code: "invalidParams" },
  });

  gateway.emit({ name: "runStarted" });
  await c.next();
  c.send(command(4, "switchSession", { id: "s1" }));
  expect(await c.next()).toMatchObject({ id: 4, error: { code: "runActive" } });
  c.send(command(5, "newSession", {}));
  expect(await c.next()).toMatchObject({ id: 5, error: { code: "runActive" } });
  expect(gateway.sessionSwitches).toEqual([]);
});

test("getStats reports the session's counts and the runs measured by the bridge", async () => {
  const gateway = new FakeGateway();
  gateway.statistics = {
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 5,
    tokens: 1200,
    cost: 0.25,
  };
  const c = await ready(await bridge(undefined, gateway));
  for (let i = 0; i < 2; i++) {
    gateway.emit({ name: "runStarted" });
    gateway.emit({ name: "runSettled", stopReason: "success" });
    await c.next();
    await c.next();
  }

  c.send(command(2, "getStats", {}));

  expect(await c.next()).toMatchObject({
    id: 2,
    result: {
      userMessages: 2,
      assistantMessages: 3,
      toolCalls: 5,
      tokens: 1200,
      cost: 0.25,
      runs: 2,
    },
  });
});

test("run stats restart with each session", async () => {
  const gateway = new FakeGateway();
  const c = await ready(await bridge(undefined, gateway));
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "runSettled", stopReason: "success" });
  await c.next();
  await c.next();

  c.send(command(2, "newSession", {}));
  await c.next();
  await c.next();
  c.send(command(3, "getStats", {}));

  expect(await c.next()).toMatchObject({
    id: 3,
    result: { runs: 0, runDurationMs: 0 },
  });
});
