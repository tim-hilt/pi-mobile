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
import type { GatewayEvent } from "./gateway.js";
import { PiGateway, type PiSession } from "./piGateway.js";

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
  disposed = false;
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
  dispose = () => {
    this.disposed = true;
  };

  emit(event: unknown): void {
    for (const listener of this.listeners) listener(event as AgentSessionEvent);
  }
}

function setup() {
  const pi = new FakePiSession();
  const gateway = new PiGateway(pi, process.cwd());
  const events: GatewayEvent[] = [];
  gateway.subscribe((event) => events.push(event));
  return { pi, gateway, events };
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

test("dispose stops event delivery and disposes the pi session", async () => {
  const { pi, gateway, events } = setup();
  gateway.dispose();
  pi.emit({ type: "agent_start" });

  expect(pi.disposed).toBe(true);
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
  const gateway = new PiGateway(new FakePiSession(), dir);

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
