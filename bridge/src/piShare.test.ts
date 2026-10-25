import type {
  SessionEntry,
  SlashCommandInfo,
} from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import type { GatewayEvent, ModelInfo } from "./gateway.js";
import type { ShareRecord } from "./link.js";
import { PiShare, type PiEvent, type PiHost } from "./piShare.js";

/** Stands in for the pi process the extension runs in: records what the share asks of it. */
class FakeHost implements PiHost {
  readonly sent: Array<[string, string | undefined]> = [];
  aborts = 0;
  /** Whether pi has no run going; a run makes the share queue prompts. */
  idle = true;
  pendingInPi = false;
  /** Messages on the current branch, as pi stores them. */
  messages: unknown[] = [];
  /** Further entries off the branch (other branches, usage entries). */
  extraEntries: unknown[] = [];
  id = "s1";
  name: string | undefined;
  cwd = "/work";
  commandList: Array<Partial<SlashCommandInfo>> = [];
  activeModel: ModelInfo | undefined;
  level = "off";
  levels = ["off"];
  context: { tokens: number | null; contextWindow: number } | undefined;
  /** Pi's models carry much more than the share passes on. */
  modelList: Array<ModelInfo & Record<string, unknown>> = [];
  /** `[provider, id]` of every model pi switched to. */
  readonly selected: Array<[string, string]> = [];
  /** When set, `setModel` rejects with it. */
  refuseModel: Error | undefined;

  send = (text: string, deliverAs?: "steer" | "followUp") => {
    this.sent.push([text, deliverAs]);
  };
  abort = () => {
    this.aborts++;
  };
  isIdle = () => this.idle;
  hasPendingMessages = () => this.pendingInPi;
  branch = () =>
    [
      { type: "model_change" },
      ...this.messages.map((message) => ({ type: "message", message })),
    ] as SessionEntry[];
  entries = () => [...this.branch(), ...this.extraEntries] as SessionEntry[];
  sessionId = () => this.id;
  sessionName = () => this.name;
  commands = () => this.commandList as SlashCommandInfo[];
  model = () => this.activeModel;
  thinkingLevel = () => this.level;
  thinkingLevels = () => this.levels;
  setThinkingLevel = (level: string) => {
    this.level = level;
  };
  contextUsage = () => this.context;
  models = () => this.modelList;
  setModel = async (provider: string, id: string) => {
    if (this.refuseModel) throw this.refuseModel;
    this.selected.push([provider, id]);
  };
}

function setup() {
  const host = new FakeHost();
  const records: ShareRecord[] = [];
  const share = new PiShare(host, (r) => records.push(r));
  const events = () =>
    records.flatMap((r) => (r.type === "event" ? [r.event] : []));
  const emit = (event: object) => share.handle(event as PiEvent);
  return { host, share, records, events, emit };
}

const textDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});
const thinkingDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "thinking_delta", delta },
});
const assistantEnd = (
  content: unknown[],
  stopReason = "stop",
  errorMessage?: string
) => ({
  type: "message_end",
  message: { role: "assistant", content, stopReason, errorMessage },
});
const usage = (tokens: number, cost: number) => ({
  input: tokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: cost },
});
const userEnd = (content: unknown) => ({
  type: "message_end",
  message: { role: "user", content },
});

test("a run streams deltas between its start and settle; the start counts once", () => {
  const { events, emit } = setup();

  emit({ type: "agent_start" });
  emit(thinkingDelta("hm"));
  emit(textDelta("Hel"));
  emit({ type: "agent_start" }); // a retry within the same run
  emit(textDelta("lo"));
  emit({ type: "agent_settled", aborted: false });

  expect(events()).toEqual([
    { name: "runStarted" },
    { name: "delta", kind: "thinking", text: "hm" },
    { name: "delta", kind: "text", text: "Hel" },
    { name: "delta", kind: "text", text: "lo" },
    { name: "runSettled", stopReason: "success" },
  ]);
});

test("a prompt from the app is sent to pi as typed input", () => {
  const { host, share } = setup();

  share.prompt("/skill:tdd go");

  expect(host.sent).toEqual([["/skill:tdd go", undefined]]);
});

test("on an idle session a prompt starts a run, whatever its mode", () => {
  const { host, share, events } = setup();

  share.prompt("go", "followUp");

  expect(host.sent).toEqual([["go", undefined]]);
  expect(events()).toEqual([]);
});

test("during a run, a prompt without a mode is refused rather than guessed", () => {
  const { host, share } = setup();
  host.idle = false;

  expect(() => share.prompt("ambiguous")).toThrow(
    expect.objectContaining({ code: "runActive" })
  );
  expect(host.sent).toEqual([]);
});

test("a completed assistant message carries its full text and thinking", () => {
  const { events, emit } = setup();

  emit(
    assistantEnd([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "Hello" },
      { type: "toolCall", id: "t1", name: "read", arguments: {} },
      { type: "text", text: " world" },
    ])
  );

  expect(events()).toEqual([
    { name: "messageEnd", text: "Hello world", thinking: "plan" },
  ]);
});

test("a user message entering the conversation surfaces as its text; a skill as typed", () => {
  const { events, emit } = setup();
  const expanded = `<skill name="tdd" location="/x/tdd/SKILL.md">\nReferences are relative to /x/tdd.\n\nBody\n</skill>\n\nadd login`;

  emit(userEnd("hi"));
  emit(
    userEnd([
      { type: "text", text: "steer" },
      { type: "image", data: "…", mimeType: "image/png" },
      { type: "text", text: "ing" },
    ])
  );
  emit(userEnd(expanded));

  expect(events().filter((e) => e.name === "userMessage")).toEqual([
    { name: "userMessage", text: "hi" },
    { name: "userMessage", text: "steering" },
    { name: "userMessage", text: "/skill:tdd add login" },
  ]);
});

test("pi's tool executions surface as tool-call events", () => {
  const { events, emit } = setup();

  emit({
    type: "tool_execution_start",
    toolCallId: "t1",
    toolName: "bash",
    args: { command: "ls" },
  });
  emit({
    type: "tool_execution_update",
    toolCallId: "t1",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "a.t" }] },
  });
  emit({
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

  expect(events()).toEqual([
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

function settledAfter(
  messageEnds: object[],
  aborted = false
): GatewayEvent | undefined {
  const { events, emit } = setup();
  emit({ type: "agent_start" });
  for (const e of messageEnds) emit(e);
  emit({ type: "agent_settled", aborted });
  return events().find((e) => e.name === "runSettled");
}

test("run settled reflects the real stop reason", () => {
  expect(settledAfter([assistantEnd([], "length")])).toEqual({
    name: "runSettled",
    stopReason: "length",
  });
  expect(settledAfter([assistantEnd([], "aborted")])).toEqual({
    name: "runSettled",
    stopReason: "aborted",
  });
  expect(settledAfter([], true)).toEqual({
    name: "runSettled",
    stopReason: "aborted",
  });
  expect(settledAfter([assistantEnd([], "error", "401 unauthorized")])).toEqual(
    {
      name: "runSettled",
      stopReason: "error",
      errorMessage: "401 unauthorized",
    }
  );
});

test("a retry that succeeds after an error settles as success", () => {
  expect(
    settledAfter([
      assistantEnd([], "error", "overloaded"),
      assistantEnd([{ type: "text", text: "ok" }]),
    ])
  ).toEqual({ name: "runSettled", stopReason: "success" });
});

test("the next run starts clean after one ended in error", () => {
  const { events, emit } = setup();
  emit({ type: "agent_start" });
  emit(assistantEnd([], "error", "boom"));
  emit({ type: "agent_settled", aborted: false });
  emit({ type: "agent_start" });
  emit({ type: "agent_settled", aborted: false });

  expect(events().filter((e) => e.name === "runSettled")).toEqual([
    { name: "runSettled", stopReason: "error", errorMessage: "boom" },
    { name: "runSettled", stopReason: "success" },
  ]);
});

test("steer and follow-up go to pi's queues and show as queued until pi takes them in", () => {
  const { host, share, events, emit } = setup();
  emit({ type: "agent_start" });
  host.idle = false;

  share.prompt("left", "steer");
  share.prompt("after", "followUp");
  emit(userEnd("left"));

  expect(host.sent).toEqual([
    ["left", "steer"],
    ["after", "followUp"],
  ]);
  expect(events().filter((e) => e.name === "queue")).toEqual([
    { name: "queue", steering: ["left"], followUp: [] },
    { name: "queue", steering: ["left"], followUp: ["after"] },
    { name: "queue", steering: [], followUp: ["after"] },
  ]);
  expect(share.history()).toMatchObject({ steering: [], followUp: ["after"] });
});

test("what pi did not take in by the time the run settles is no longer queued", () => {
  const { host, share, events, emit } = setup();
  emit({ type: "agent_start" });
  host.idle = false;
  share.prompt("after", "followUp");

  emit({ type: "agent_settled", aborted: true });

  expect(events().at(-1)).toEqual({
    name: "queue",
    steering: [],
    followUp: [],
  });
});

test("abort is forwarded to pi", () => {
  const { host, share } = setup();

  share.abort();

  expect(host.aborts).toBe(1);
});

test("the history holds user and assistant text and thinking, and each tool call after the turn that made it", () => {
  const { host, share } = setup();
  host.messages = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Hello" },
        { type: "toolCall", id: "t1", name: "bash", arguments: {} },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "t1",
      content: [{ type: "text", text: "ok" }],
      isError: false,
    },
    // A tool-call-only turn shows only its calls; t2 is still running.
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "t2", name: "read", arguments: { path: "a" } },
      ],
    },
  ];

  expect(share.history()).toEqual({
    messages: [
      { role: "user", text: "hi" },
      { role: "assistant", text: "Hello", thinking: "hm" },
      {
        role: "toolCall",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
        output: "ok",
        isError: false,
      },
      {
        role: "toolCall",
        toolCallId: "t2",
        toolName: "read",
        args: { path: "a" },
      },
    ],
    steering: [],
    followUp: [],
    cost: 0,
  });
});

test("skills are pi's skill commands, by name and description", () => {
  const { host, share } = setup();
  host.commandList = [
    {
      name: "skill:tdd",
      description: "Test-driven development.",
      source: "skill",
    },
    { name: "review", description: "A prompt.", source: "prompt" },
  ];

  expect(share.skills()).toEqual([
    { name: "tdd", description: "Test-driven development." },
  ]);
});

test("stats count the whole session, across branches", () => {
  const { host, share } = setup();
  host.messages = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
      usage: usage(100, 0.1),
    },
  ];
  host.extraEntries = [
    { type: "usage", usage: usage(50, 0.05) },
    {
      type: "message",
      message: { role: "assistant", content: [], usage: usage(10, 0.01) },
    },
  ];

  expect(share.stats()).toEqual({
    userMessages: 1,
    assistantMessages: 2,
    toolCalls: 1,
    tokens: 160,
    cost: expect.closeTo(0.16),
  });
});

test("the session introduces itself by id, name, directory and first message", () => {
  const { host, share } = setup();
  host.name = "refactor";
  host.messages = [{ role: "user", content: "fix login" }];

  expect(share.introduction()).toEqual([
    {
      type: "announce",
      info: { id: "s1", name: "refactor", cwd: "/work", preview: "fix login" },
    },
  ]);
});

test("introduced mid-run, the session also says a run is on", () => {
  const { share, emit } = setup();
  emit({ type: "agent_start" });

  expect(share.introduction().at(-1)).toEqual({
    type: "event",
    event: { name: "runStarted" },
  });
});

test("the first user message of an empty session updates its preview", () => {
  const { share, records, emit } = setup();

  emit(userEnd("fix login"));
  emit(userEnd("and logout"));
  share.infoChanged();

  expect(records.filter((r) => r.type === "info")).toEqual([
    { type: "info", info: { id: "s1", cwd: "/work", preview: "fix login" } },
    { type: "info", info: { id: "s1", cwd: "/work", preview: "fix login" } },
  ]);
});

const opus = { provider: "anthropic", id: "opus", name: "Claude Opus" };
const opusStatus = {
  model: "opus",
  provider: "anthropic",
  modelName: "Claude Opus",
  thinkingLevel: "off",
  thinkingLevels: ["off"],
};

test("the history carries the status: model, thinking, context use and the session's price", () => {
  const { host, share } = setup();
  host.activeModel = opus;
  host.level = "medium";
  host.levels = ["off", "low", "medium", "high"];
  host.context = { tokens: 18_800, contextWindow: 1_000_000 };
  host.messages = [{ role: "assistant", content: [], usage: usage(10, 0.4) }];
  host.extraEntries = [{ type: "usage", usage: usage(5, 0.02) }];

  expect(share.history()).toMatchObject({
    model: "opus",
    provider: "anthropic",
    modelName: "Claude Opus",
    thinkingLevel: "medium",
    thinkingLevels: ["off", "low", "medium", "high"],
    contextTokens: 18_800,
    contextWindow: 1_000_000,
    cost: expect.closeTo(0.42),
  });
});

test("the status leaves out what pi doesn't know", () => {
  const { host, share } = setup();
  const { messages, steering, followUp, ...status } = share.history();
  expect(status).toEqual({ cost: 0 });

  host.activeModel = opus;
  host.context = { tokens: null, contextWindow: 200_000 };
  const { messages: _, ...compacted } = share.history();
  expect(compacted).toMatchObject({ model: "opus", contextWindow: 200_000 });
  expect(compacted).not.toHaveProperty("contextTokens");
});

test("the status is sent when a turn, run, model or thinking switch, compaction or tree move changed it", () => {
  const { host, events, emit } = setup();
  const statuses = () => events().filter((e) => e.name === "status");

  emit({ type: "agent_start" });
  host.context = { tokens: 100, contextWindow: 1000 };
  emit({ type: "message_update", assistantMessageEvent: { type: "start" } });
  expect(statuses()).toEqual([]);
  emit({ type: "turn_end" });
  emit({ type: "agent_settled", aborted: false }); // unchanged
  host.activeModel = opus;
  emit({ type: "model_select" });
  host.context = { tokens: null, contextWindow: 1000 };
  emit({ type: "session_compact" });
  host.context = { tokens: 50, contextWindow: 1000 };
  emit({ type: "session_tree" });
  host.level = "high";
  emit({ type: "thinking_level_select" });

  expect(statuses()).toEqual([
    { name: "status", contextTokens: 100, contextWindow: 1000, cost: 0 },
    {
      name: "status",
      ...opusStatus,
      contextTokens: 100,
      contextWindow: 1000,
      cost: 0,
    },
    { name: "status", ...opusStatus, contextWindow: 1000, cost: 0 },
    {
      name: "status",
      ...opusStatus,
      contextTokens: 50,
      contextWindow: 1000,
      cost: 0,
    },
    {
      name: "status",
      ...opusStatus,
      thinkingLevel: "high",
      contextTokens: 50,
      contextWindow: 1000,
      cost: 0,
    },
  ]);
});

test("models are those pi offers to switch to, by provider, id and name", () => {
  const { host, share } = setup();
  host.modelList = [
    { provider: "anthropic", id: "opus", name: "Claude Opus", extra: 1 },
  ];

  expect(share.models()).toEqual([
    { provider: "anthropic", id: "opus", name: "Claude Opus" },
  ]);
});

test("setting the model asks pi to switch, and fails when pi can't", async () => {
  const { host, share } = setup();

  await share.setModel("anthropic", "opus");
  host.refuseModel = new Error("no API key for anthropic");
  const refused = share.setModel("anthropic", "sonnet");

  await expect(refused).rejects.toThrow("no API key for anthropic");
  expect(host.selected).toEqual([["anthropic", "opus"]]);
});

test("setting the thinking level asks pi to switch", () => {
  const { host, share } = setup();

  share.setThinkingLevel("high");

  expect(host.level).toBe("high");
});
