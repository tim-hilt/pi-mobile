import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeGateway } from "./fakeGateway.js";
import { Session, type BridgeEvent } from "./session.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** A session over a fresh gateway, with a client joined from scratch. */
function joined() {
  const gateway = new FakeGateway();
  const session = new Session(gateway, { replayLimit: 100, onChange() {} });
  const received: BridgeEvent[] = [];
  session.subscribe(0, undefined, (event) => received.push(event));
  received.length = 0; // the empty snapshot
  return { gateway, session, received };
}

test("a burst of deltas goes out as one event per run of the same kind", () => {
  const { gateway, received } = joined();

  gateway.emit({ name: "delta", kind: "thinking", text: "hm" });
  gateway.emit({ name: "delta", kind: "text", text: "Hel" });
  gateway.emit({ name: "delta", kind: "text", text: "lo" });
  expect(received.map((e) => e.data)).toEqual([
    { kind: "thinking", text: "hm" },
  ]);

  vi.runAllTimers();
  expect(received).toEqual([
    { seq: 1, name: "delta", data: { kind: "thinking", text: "hm" } },
    { seq: 2, name: "delta", data: { kind: "text", text: "Hello" } },
  ]);
});

test("a burst of tool output updates goes out as the latest one", () => {
  const { gateway, received } = joined();
  const update = (output: string) =>
    gateway.emit({
      name: "toolCall",
      phase: "update",
      toolCallId: "t1",
      toolName: "bash",
      output,
    });

  update("1\n");
  update("1\n2\n");
  vi.runAllTimers();

  expect(received).toEqual([
    {
      seq: 1,
      name: "toolCall",
      data: {
        phase: "update",
        toolCallId: "t1",
        toolName: "bash",
        output: "1\n2\n",
      },
    },
  ]);
});

test("any other event first sends what is held back, keeping the order", () => {
  const { gateway, received } = joined();

  gateway.emit({ name: "delta", kind: "text", text: "Hi" });
  gateway.emit({ name: "messageEnd", text: "Hi", thinking: "" });

  expect(received).toEqual([
    { seq: 1, name: "delta", data: { kind: "text", text: "Hi" } },
    { seq: 2, name: "messageEnd", data: { text: "Hi", thinking: "" } },
  ]);
});

test("a snapshot covers deltas held back, so they are never sent twice", () => {
  const { gateway, session, received } = joined();
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "delta", kind: "text", text: "Hel" });

  const late: BridgeEvent[] = [];
  session.subscribe(0, undefined, (event) => late.push(event));
  gateway.emit({ name: "delta", kind: "text", text: "lo" });
  vi.runAllTimers();

  expect(late[0]).toMatchObject({
    seq: 2,
    name: "transcript",
    data: { messages: [{ role: "assistant", text: "Hel", streaming: true }] },
  });
  expect(late.slice(1)).toEqual([
    { seq: 3, name: "delta", data: { kind: "text", text: "lo" } },
  ]);
  expect(received.map((e) => e.seq)).toEqual([1, 2, 3]);
});
