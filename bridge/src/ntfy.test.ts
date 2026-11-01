import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { FakeGateway } from "./fakeGateway.js";
import type { StopReason } from "./gateway.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import type { Presence, PresenceProbe } from "./presence.js";
import { startBridge, type Bridge } from "./server.js";

interface Post {
  method?: string;
  url?: string;
  body: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
// Only the clock is faked, so tests can step past the notification cooldown.
beforeEach(() => void vi.useFakeTimers({ toFake: ["Date"] }));
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const COOLDOWN_MS = 5000;
const afterCooldown = () => vi.setSystemTime(Date.now() + COOLDOWN_MS);
const probing =
  (presence: Presence): PresenceProbe =>
  async () =>
    presence;

/** A real local HTTP server standing in for ntfy.sh; records every request and answers with `status`. */
async function fakeNtfy(status = 200) {
  const posts: Post[] = [];
  const waiting: Array<() => void> = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      posts.push({ method: req.method, url: req.url, body });
      res.writeHead(status).end();
      waiting.splice(0).forEach((wake) => wake());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    posts,
    /** Resolves with the first request, once it has arrived. */
    async firstPost(): Promise<Post> {
      while (posts.length === 0)
        await new Promise<void>((wake) => waiting.push(wake));
      return posts[0]!;
    },
  };
}

async function startNotifying(
  ntfy: { baseUrl: string; topic: string },
  presence: PresenceProbe = probing("present")
) {
  const b = await startBridge({ token: "t", port: 0, ntfy, presence });
  cleanups.push(() => b.close());
  return b;
}

async function bridgeNotifying(
  ntfy: { baseUrl: string; topic: string },
  presence?: PresenceProbe
) {
  const gateway = new FakeGateway();
  (await startNotifying(ntfy, presence)).hub.add(gateway);
  return gateway;
}

/** Lets in-flight notification decisions and deliveries finish. */
const settle = () => new Promise((r) => setTimeout(r, 50));

const runThrough = (gateway: FakeGateway, stopReason: StopReason) => {
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "runSettled", stopReason });
};

const ICON = "https://upload.wikimedia.org/wikipedia/commons/8/81/Pi_logo.png";

test("a finished run is published to the topic with the last answer", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({
    baseUrl: ntfy.baseUrl,
    topic: "xk3",
  });
  gateway.current = { ...gateway.current, id: "s7", cwd: "/home/me/leaf" };
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "messageEnd", text: "first", thinking: "" });
  gateway.emit({ name: "messageEnd", text: "  **Done.**  ", thinking: "hmm" });
  gateway.emit({ name: "messageEnd", text: "", thinking: "only thinking" });
  gateway.emit({ name: "runSettled", stopReason: "success" });

  const post = await ntfy.firstPost();

  expect(post).toMatchObject({ method: "POST", url: "/" });
  expect(JSON.parse(post.body)).toEqual({
    topic: "xk3",
    title: "leaf: Agent Finished",
    message: "**Done.**",
    tags: ["robot"],
    markdown: true,
    icon: ICON,
    click: "pimobile://session?id=s7",
  });
});

test("tapping the notification opens its session in the app", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  gateway.current = { ...gateway.current, id: "a/b c&d" };

  runThrough(gateway, "success");

  const { click } = JSON.parse((await ntfy.firstPost()).body);
  expect(new URL(click).searchParams.get("id")).toBe("a/b c&d");
});

test.each<[StopReason, string]>([
  ["error", "Agent Failed"],
  ["length", "Agent Cut Off"],
])("a run that settles as %s is titled %s", async (stopReason, title) => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });

  runThrough(gateway, stopReason);

  expect(JSON.parse((await ntfy.firstPost()).body).title).toBe(
    `work: ${title}`
  );
});

test("an interrupted run is not announced", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });

  runThrough(gateway, "aborted");
  runThrough(gateway, "success");

  await ntfy.firstPost();
  await new Promise((r) => setTimeout(r, 50));
  expect(ntfy.posts.map((p) => JSON.parse(p.body).title)).toEqual([
    "work: Agent Finished",
  ]);
});

test("a named session is titled by its name", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  gateway.current = { ...gateway.current, name: "refactor auth" };

  runThrough(gateway, "success");

  expect(JSON.parse((await ntfy.firstPost()).body).title).toBe(
    "refactor auth: Agent Finished"
  );
});

test("a run without an answer falls back to its error, then a generic message", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  gateway.emit({ name: "runStarted" });
  gateway.emit({
    name: "runSettled",
    stopReason: "error",
    errorMessage: "rate limited",
  });
  await ntfy.firstPost();
  afterCooldown();
  runThrough(gateway, "success");

  while (ntfy.posts.length < 2) await new Promise((r) => setTimeout(r, 5));

  expect(ntfy.posts.map((p) => JSON.parse(p.body).message)).toEqual([
    "rate limited",
    "The agent finished.",
  ]);
});

test("an answer from an earlier run is not reported again", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "messageEnd", text: "old answer", thinking: "" });
  gateway.emit({ name: "runSettled", stopReason: "success" });
  await ntfy.firstPost();
  afterCooldown();
  runThrough(gateway, "error");

  while (ntfy.posts.length < 2) await new Promise((r) => setTimeout(r, 5));

  expect(JSON.parse(ntfy.posts[1]!.body).message).toBe("The agent finished.");
});

test("a long answer is truncated", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "messageEnd", text: "x".repeat(1500), thinking: "" });
  gateway.emit({ name: "runSettled", stopReason: "success" });

  const { message } = JSON.parse((await ntfy.firstPost()).body);

  expect(message).toBe(`${"x".repeat(1000)}…`);
});

test("a base URL with a path still publishes to it", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({
    baseUrl: `${ntfy.baseUrl}/ntfy/`,
    topic: "t",
  });

  runThrough(gateway, "success");

  expect((await ntfy.firstPost()).url).toBe("/ntfy");
});

test("an unreachable or failing ntfy never disturbs the bridge", async () => {
  const failing = await fakeNtfy(500);
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const deadUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  cleanups.push(() => void process.off("unhandledRejection", onUnhandled));

  for (const baseUrl of [deadUrl, failing.baseUrl]) {
    const gateway = await bridgeNotifying({ baseUrl, topic: "t" });
    expect(() => runThrough(gateway, "success")).not.toThrow();
  }
  await failing.firstPost();
  await new Promise((resolve) => setTimeout(resolve, 50));

  expect(unhandled).toEqual([]);
});

test("a burst of settled runs in one session notifies once per 5 s", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });

  runThrough(gateway, "success");
  runThrough(gateway, "error");
  await settle();
  expect(ntfy.posts).toHaveLength(1);

  vi.setSystemTime(Date.now() + COOLDOWN_MS - 1);
  runThrough(gateway, "success");
  await settle();
  expect(ntfy.posts).toHaveLength(1);

  vi.setSystemTime(Date.now() + 1);
  runThrough(gateway, "success");
  await settle();
  expect(ntfy.posts).toHaveLength(2);
});

test("the cooldown is per session", async () => {
  const ntfy = await fakeNtfy();
  const bridge = await startNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  const [one, two] = [new FakeGateway("s1"), new FakeGateway("s2")];
  bridge.hub.add(one);
  bridge.hub.add(two);

  runThrough(one, "success");
  runThrough(two, "success");
  await settle();

  expect(ntfy.posts).toHaveLength(2);
});

test.each<Presence>(["away", "present", "unknown"])(
  "with the terminal's focus unknown, a %s user is notified",
  async (presence) => {
    const ntfy = await fakeNtfy();
    const gateway = await bridgeNotifying(
      { baseUrl: ntfy.baseUrl, topic: "t" },
      probing(presence)
    );

    runThrough(gateway, "success");

    await ntfy.firstPost();
  }
);

test("presence is probed when a run settles, not before", async () => {
  const ntfy = await fakeNtfy();
  const probe = vi.fn(probing("away"));
  const gateway = await bridgeNotifying(
    { baseUrl: ntfy.baseUrl, topic: "t" },
    probe
  );
  gateway.emit({ name: "runStarted" });
  await settle();
  expect(probe).not.toHaveBeenCalled();

  gateway.emit({ name: "runSettled", stopReason: "success" });
  await ntfy.firstPost();

  expect(probe).toHaveBeenCalledTimes(1);
});

/** A real app connection: handshaken and joined to `sessionId`, snapshot received. */
async function appJoins(bridge: Bridge, sessionId: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
    headers: { Authorization: "Bearer t" },
  });
  cleanups.push(() => ws.terminate());
  const command = (id: number, name: string, params: object) =>
    ws.send(JSON.stringify({ type: "command", id, name, params }) + "\n");
  const received = (name: string) =>
    new Promise<void>((resolve) =>
      ws.on("message", function onMessage(data) {
        if (data.toString().includes(`"name":"${name}"`)) {
          ws.off("message", onMessage);
          resolve();
        }
      })
    );
  await new Promise((resolve) => ws.once("open", resolve));
  command(1, "hello", { protocolVersion: PROTOCOL_VERSION });
  await new Promise((resolve) => ws.once("message", resolve));
  const snapshot = received("transcript");
  command(2, "joinSession", { id: sessionId });
  await snapshot;
  return {
    leave: () => command(3, "joinSession", { id: "elsewhere" }),
    disconnect: () =>
      new Promise((resolve) => {
        ws.once("close", resolve);
        ws.close();
      }),
  };
}

test("a run of a session an app has joined is not announced", async () => {
  const ntfy = await fakeNtfy();
  const bridge = await startNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  const gateway = new FakeGateway("s1");
  bridge.hub.add(gateway);
  await appJoins(bridge, "s1");

  runThrough(gateway, "success");
  await settle();

  expect(ntfy.posts).toEqual([]);
});

test("a joined session doesn't silence the others", async () => {
  const ntfy = await fakeNtfy();
  const bridge = await startNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  const [watched, other] = [new FakeGateway("s1"), new FakeGateway("s2")];
  bridge.hub.add(watched);
  bridge.hub.add(other);
  await appJoins(bridge, "s1");

  runThrough(watched, "success");
  runThrough(other, "success");
  await settle();

  expect(
    ntfy.posts.map((p) =>
      new URL(JSON.parse(p.body).click).searchParams.get("id")
    )
  ).toEqual(["s2"]);
});

test("a session is announced again once its app disconnects", async () => {
  const ntfy = await fakeNtfy();
  const bridge = await startNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  const gateway = new FakeGateway("s1");
  bridge.hub.add(gateway);
  const app = await appJoins(bridge, "s1");
  runThrough(gateway, "success");
  await settle();
  expect(ntfy.posts).toEqual([]);

  await app.disconnect();
  await settle(); // the bridge notices the closed socket
  runThrough(gateway, "success");

  await ntfy.firstPost();
});

test("a session is announced again once its app joins another", async () => {
  const ntfy = await fakeNtfy();
  const bridge = await startNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });
  const [one, two] = [new FakeGateway("s1"), new FakeGateway("elsewhere")];
  bridge.hub.add(one);
  bridge.hub.add(two);
  const app = await appJoins(bridge, "s1");

  app.leave();
  await settle();
  runThrough(one, "success");

  await ntfy.firstPost();
});
