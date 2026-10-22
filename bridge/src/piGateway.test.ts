import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { GatewayEvent } from "./gateway.js";
import { PiGateway, type PiRuntime, type PiSession } from "./piGateway.js";

/**
 * Stands in for pi's `AgentSession`: records calls and lets a test emit the
 * session events pi would, in the shapes documented in pi's SDK docs.
 */
class FakePiSession implements PiSession {
  /** What pi's `messages` holds: completed messages of every role. */
  messages: AgentSession["messages"] = [];
  readonly steers: string[] = [];
  readonly followUps: string[] = [];
  steeringQueue: string[] = [];
  followUpQueue: string[] = [];
  aborts = 0;
  /** What pi reports as this session's identity. */
  sessionId = "s1";
  /** What pi's `getSessionStats()` reports; only the fields the bridge reads. */
  stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    tokens: { total: 0 },
    cost: 0,
  };
  /** What pi's resource loader reports for skills. */
  skills: Array<{ name: string; description: string; filePath: string }> = [];
  resourceLoader = {
    getSkills: () => ({ skills: this.skills, diagnostics: [] }),
  } as unknown as PiSession["resourceLoader"];
  /** When set, `prompt` rejects with it before the prompt is accepted. */
  rejectWith: Error | undefined;
  /** Resolves the pending `prompt()` call, as pi does when the run finishes. */
  finishRun: () => void = () => {};

  private listeners = new Set<AgentSessionEventListener>();

  prompt = async (text: string, options?: PromptOptions) => {
    if (this.rejectWith) throw this.rejectWith;
    options?.preflightResult?.("started");
    return new Promise<void>((resolve) => (this.finishRun = resolve));
  };
  steer = async (text: string) => {
    this.steers.push(text);
    return "queued" as const;
  };
  followUp = async (text: string) => {
    this.followUps.push(text);
    return "queued" as const;
  };
  abort = async () => {
    this.aborts++;
  };
  getSteeringMessages = () => this.steeringQueue;
  getFollowUpMessages = () => this.followUpQueue;
  clearQueue = () => {
    const cleared = {
      steering: this.steeringQueue,
      followUp: this.followUpQueue,
    };
    this.steeringQueue = [];
    this.followUpQueue = [];
    return cleared;
  };
  subscribe = (listener: AgentSessionEventListener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSessionStats = () =>
    this.stats as ReturnType<PiSession["getSessionStats"]>;

  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event as AgentSessionEvent);
  }
}

/**
 * Stands in for pi's `AgentSessionRuntime`: replacing the session installs
 * `next` as the active one, as pi does after tearing the old one down.
 */
class FakePiRuntime implements PiRuntime {
  next = new FakePiSession();
  /** Paths passed to `switchSession`. */
  readonly switches: string[] = [];
  disposed = false;
  /** When set, replacing the session reports it cancelled (an extension vetoed it). */
  cancel = false;

  constructor(public session: FakePiSession) {}

  newSession = async () => this.replace();
  switchSession = async (path: string) => {
    this.switches.push(path);
    return this.replace();
  };
  dispose = async () => {
    this.disposed = true;
  };

  private replace() {
    if (this.cancel) return { cancelled: true };
    this.session = this.next;
    return { cancelled: false };
  }
}

const info = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  path: `/sessions/${id}.jsonl`,
  id,
  cwd: "/work",
  created: new Date("2025-01-01T00:00:00Z"),
  modified: new Date("2025-01-02T03:04:05Z"),
  messageCount: 3,
  firstMessage: `hello from ${id}`,
  allMessagesText: "",
  ...extra,
});

function setup(stored: SessionInfo[] = []) {
  const pi = new FakePiSession();
  const runtime = new FakePiRuntime(pi);
  const gateway = new PiGateway(runtime, process.cwd(), async () => stored);
  const events: GatewayEvent[] = [];
  gateway.subscribe((event) => events.push(event));
  return { pi, runtime, gateway, events };
}

const textDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});
const thinkingDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta },
});

test("an accepted prompt starts a run; streamed deltas and settle follow", async () => {
  const { pi, gateway, events } = setup();

  // Resolves on acceptance, while pi's own prompt() is still running.
  await gateway.prompt("hi");
  expect(events).toEqual([{ name: "runStarted" }]);

  pi.emit({ type: "agent_start" });
  pi.emit(thinkingDelta("hm"));
  pi.emit(textDelta("Hel"));
  pi.emit(textDelta("lo"));
  pi.emit({ type: "agent_settled", aborted: false });

  expect(events).toEqual([
    { name: "runStarted" },
    { name: "delta", kind: "thinking", text: "hm" },
    { name: "delta", kind: "text", text: "Hel" },
    { name: "delta", kind: "text", text: "lo" },
    { name: "runSettled", stopReason: "success" },
  ]);
});

const assistantEnd = (
  content: unknown[],
  stopReason = "stop",
  errorMessage?: string
) => ({
  type: "message_end",
  message: { role: "assistant", content, stopReason, errorMessage },
});

test("a completed assistant message carries its full text and thinking", async () => {
  const { pi, gateway, events } = setup();
  await gateway.prompt("hi");
  events.length = 0;

  pi.emit(
    assistantEnd([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "t1", name: "read", arguments: {} },
      { type: "text", text: " world" },
    ])
  );

  expect(events).toEqual([
    { name: "messageEnd", text: "Hello world", thinking: "plan" },
  ]);
});

test("a user message entering the conversation surfaces as its text", async () => {
  const { pi, gateway, events } = setup();
  await gateway.prompt("hi");
  events.length = 0;

  pi.emit({ type: "message_end", message: { role: "user", content: "hi" } });
  pi.emit({
    type: "message_end",
    message: {
      role: "user",
      content: [
        { type: "text", text: "steer" },
        { type: "image", data: "…", mimeType: "image/png" },
        { type: "text", text: "ing" },
      ],
    },
  });

  expect(events).toEqual([
    { name: "userMessage", text: "hi" },
    { name: "userMessage", text: "steering" },
  ]);
});

test("pi's queue updates surface as queue events", async () => {
  const { pi, events } = setup();

  pi.emit({ type: "queue_update", steering: ["left"], followUp: ["later"] });

  expect(events).toEqual([
    { name: "queue", steering: ["left"], followUp: ["later"] },
  ]);
});

test("the queue and its clearing are read through to pi", () => {
  const { pi, gateway } = setup();
  pi.steeringQueue = ["left"];
  pi.followUpQueue = ["later"];

  expect(gateway.queue()).toEqual({ steering: ["left"], followUp: ["later"] });
  expect(gateway.clearQueue()).toEqual({
    steering: ["left"],
    followUp: ["later"],
  });
  expect(gateway.queue()).toEqual({ steering: [], followUp: [] });
});

test("abort is forwarded to pi", async () => {
  const { pi, gateway } = setup();

  await gateway.abort();

  expect(pi.aborts).toBe(1);
});

test("pi's tool executions surface as tool-call events", async () => {
  const { pi, gateway, events } = setup();
  await gateway.prompt("hi");
  events.length = 0;

  pi.emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
  });
  pi.emit({
    type: "tool_execution_update",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
    partialResult: { content: [{ type: "text", text: "a.t" }] },
  });
  pi.emit({
    type: "tool_execution_end",
    toolCallId: "t1",
    toolName: "bash",
    result: {
      content: [
        { type: "text", text: "a.txt\n" },
        { type: "image", data: "…", mimeType: "image/png" },
      ],
    },
    isError: false,
    durationMs: 12,
  });

  expect(events).toEqual([
    {
      name: "toolCall",
      phase: "start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    },
    {
      name: "toolCall",
      phase: "update",
      toolCallId: "t1",
      toolName: "bash",
      output: "a.t",
    },
    {
      name: "toolCall",
      phase: "end",
      toolCallId: "t1",
      toolName: "bash",
      output: "a.txt\n",
      isError: false,
      durationMs: 12,
    },
  ]);
});

async function settledAfter(
  messageEnds: unknown[],
  aborted = false
): Promise<GatewayEvent | undefined> {
  const { pi, gateway, events } = setup();
  await gateway.prompt("hi");
  for (const e of messageEnds) pi.emit(e);
  pi.emit({ type: "agent_settled", aborted });
  return events.find((e) => e.name === "runSettled");
}

test("run settled reflects the real stop reason", async () => {
  expect(await settledAfter([assistantEnd([], "length")])).toEqual({
    name: "runSettled",
    stopReason: "length",
  });
  expect(await settledAfter([assistantEnd([], "aborted")])).toEqual({
    name: "runSettled",
    stopReason: "aborted",
  });
  expect(await settledAfter([], true)).toEqual({
    name: "runSettled",
    stopReason: "aborted",
  });
  expect(
    await settledAfter([assistantEnd([], "error", "401 unauthorized")])
  ).toEqual({
    name: "runSettled",
    stopReason: "error",
    errorMessage: "401 unauthorized",
  });
});

test("a retry that succeeds after an error settles as success", async () => {
  expect(
    await settledAfter([
      assistantEnd([], "error", "overloaded"),
      assistantEnd([{ type: "text", text: "ok" }]),
    ])
  ).toEqual({ name: "runSettled", stopReason: "success" });
});

test("the next run starts clean after one ended in error", async () => {
  const { pi, gateway, events } = setup();
  await gateway.prompt("one");
  pi.emit(assistantEnd([], "error", "boom"));
  pi.emit({ type: "agent_settled", aborted: false });
  await gateway.prompt("two");
  pi.emit({ type: "agent_settled", aborted: false });

  expect(events.filter((e) => e.name === "runSettled")).toEqual([
    { name: "runSettled", stopReason: "error", errorMessage: "boom" },
    { name: "runSettled", stopReason: "success" },
  ]);
  expect(events.filter((e) => e.name === "runStarted")).toHaveLength(2);
});

test("a refused prompt rejects and starts no run", async () => {
  const { pi, gateway, events } = setup();
  pi.rejectWith = new Error("No API key found");

  await expect(gateway.prompt("hi")).rejects.toThrow("No API key found");
  expect(events).toEqual([]);
});

test("steer and follow-up are forwarded to pi's queues", async () => {
  const { pi, gateway } = setup();
  await gateway.steer("left");
  await gateway.followUp("after");

  expect(pi.steers).toEqual(["left"]);
  expect(pi.followUps).toEqual(["after"]);
});

test("dispose stops event delivery and disposes the pi runtime", async () => {
  const { pi, runtime, gateway, events } = setup();
  await gateway.dispose();
  pi.emit({ type: "agent_start" });

  expect(runtime.disposed).toBe(true);
  expect(events).toEqual([]);
});

test("the transcript holds completed user and assistant messages, text and thinking only", () => {
  const { pi, gateway } = setup();
  pi.messages = [
    { role: "system", content: "be nice" },
    { role: "user", content: "hi" },
    {
      role: "user",
      content: [
        { type: "text", text: "see " },
        { type: "image", data: "...", mimeType: "image/png" },
        { type: "text", text: "this" },
      ],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Hello" },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      ],
    },
    { role: "toolResult", toolCallId: "t1", content: [] },
    // A tool-call-only turn has nothing to show.
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "t2", name: "bash", arguments: {} }],
    },
  ] as never;

  expect(gateway.transcript()).toEqual([
    { role: "user", text: "hi" },
    { role: "user", text: "see this" },
    { role: "assistant", text: "Hello", thinking: "hm" },
  ]);
});

test("skills are the ones pi's resource loader discovered, by name and description", () => {
  const { pi, gateway } = setup();
  pi.skills = [
    {
      name: "tdd",
      description: "Test-driven development.",
      filePath: "/x/tdd/SKILL.md",
    },
    { name: "pr", description: "Write a PR body.", filePath: "/x/pr/SKILL.md" },
  ];

  expect(gateway.skills()).toEqual([
    { name: "tdd", description: "Test-driven development." },
    { name: "pr", description: "Write a PR body." },
  ]);
});

test("file search covers the session's working directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-gw-"));
  writeFileSync(join(dir, "notes.md"), "");
  const gateway = new PiGateway(new FakePiRuntime(new FakePiSession()), dir);

  expect(await gateway.searchFiles("note", 5)).toEqual(["notes.md"]);

  rmSync(dir, { recursive: true });
});

test("an invoked skill shows as the command the user typed, not its expanded body", async () => {
  const { pi, gateway, events } = setup();
  await gateway.prompt("/skill:tdd add login");
  events.length = 0;
  const expanded = (rest = "") =>
    `<skill name="tdd" location="/x/tdd/SKILL.md">\nReferences are relative to /x/tdd.\n\nBody\n</skill>${rest}`;

  pi.emit({
    type: "message_end",
    message: { role: "user", content: expanded("\n\nadd login") },
  });
  pi.emit({
    type: "message_end",
    message: { role: "user", content: expanded() },
  });
  pi.messages = [{ role: "user", content: expanded("\n\nadd login") }] as never;

  expect(events).toEqual([
    { name: "userMessage", text: "/skill:tdd add login" },
    { name: "userMessage", text: "/skill:tdd" },
  ]);
  expect(gateway.transcript()).toEqual([
    { role: "user", text: "/skill:tdd add login" },
  ]);
});

test("sessions are the stored ones as summaries, with names where given", async () => {
  const { gateway } = setup([
    info("s2", { name: "Refactor" }),
    info("s1", { messageCount: 7 }),
  ]);

  expect(await gateway.sessions()).toEqual([
    {
      id: "s2",
      name: "Refactor",
      preview: "hello from s2",
      modifiedAt: "2025-01-02T03:04:05.000Z",
      messageCount: 3,
    },
    {
      id: "s1",
      preview: "hello from s1",
      modifiedAt: "2025-01-02T03:04:05.000Z",
      messageCount: 7,
    },
  ]);
});

test("the session id and stats are read through to pi", () => {
  const { pi, gateway } = setup();
  pi.sessionId = "abc";
  pi.stats = {
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 5,
    tokens: { total: 1200 },
    cost: 0.25,
  };

  expect(gateway.sessionId()).toBe("abc");
  expect(gateway.stats()).toEqual({
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 5,
    tokens: 1200,
    cost: 0.25,
  });
});

test("switching sessions follows the new pi session and forgets the old one", async () => {
  const { pi, runtime, gateway, events } = setup([info("s1"), info("s2")]);
  runtime.next.sessionId = "s2";
  runtime.next.messages = [{ role: "user", content: "from s2" } as never];

  await gateway.switchSession("s2");

  expect(runtime.switches).toEqual(["/sessions/s2.jsonl"]);
  expect(events).toEqual([{ name: "sessionChanged" }]);
  expect(gateway.sessionId()).toBe("s2");
  expect(gateway.transcript()).toEqual([{ role: "user", text: "from s2" }]);

  events.length = 0;
  pi.emit({ type: "agent_start" });
  runtime.next.emit({ type: "queue_update", steering: ["x"], followUp: [] });
  expect(events).toEqual([{ name: "queue", steering: ["x"], followUp: [] }]);
});

test("a new session is followed the same way", async () => {
  const { pi, runtime, gateway, events } = setup();
  runtime.next.sessionId = "fresh";

  await gateway.newSession();

  expect(events).toEqual([{ name: "sessionChanged" }]);
  expect(gateway.sessionId()).toBe("fresh");
  events.length = 0;
  pi.emit({ type: "agent_start" });
  expect(events).toEqual([]);
});

test("a run interrupted by a switch does not stop the next session's run from starting", async () => {
  const { runtime, gateway, events } = setup([info("s2")]);
  await gateway.prompt("hi");

  await gateway.switchSession("s2");
  events.length = 0;
  runtime.next.emit({ type: "agent_start" });

  expect(events).toEqual([{ name: "runStarted" }]);
});

test.each(["new", "switch"] as const)(
  "a %s session pi cancels rejects and changes nothing",
  async (kind) => {
    const { runtime, gateway, events } = setup([info("s2")]);
    runtime.cancel = true;

    await expect(
      kind === "new" ? gateway.newSession() : gateway.switchSession("s2")
    ).rejects.toThrow("cancelled");

    expect(events).toEqual([]);
    expect(gateway.sessionId()).toBe("s1");
  }
);

test("switching to a session that is not stored rejects", async () => {
  const { gateway } = setup([info("s1")]);

  await expect(gateway.switchSession("gone")).rejects.toThrow("gone");
});
