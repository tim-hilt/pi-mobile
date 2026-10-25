import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, test } from "vitest";
import { FakeGateway } from "./fakeGateway.js";
import type { StopReason } from "./gateway.js";
import { startBridge } from "./server.js";

interface Post {
  method?: string;
  url?: string;
  body: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

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

async function bridgeNotifying(ntfy: { baseUrl: string; topic: string }) {
  const gateway = new FakeGateway();
  const b = await startBridge({ token: "t", port: 0, ntfy });
  cleanups.push(() => b.close());
  b.hub.add(gateway);
  return gateway;
}

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
  runThrough(gateway, "success");

  await ntfy.firstPost();
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
