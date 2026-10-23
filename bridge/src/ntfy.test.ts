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

test.each<StopReason>(["success", "error", "aborted", "length"])(
  "a run that settles as %s is posted to the topic",
  async (stopReason) => {
    const ntfy = await fakeNtfy();
    const gateway = await bridgeNotifying({
      baseUrl: ntfy.baseUrl,
      topic: "xk3-secret-topic",
    });

    runThrough(gateway, stopReason);

    const post = await ntfy.firstPost();
    expect(post).toMatchObject({ method: "POST", url: "/xk3-secret-topic" });
    expect(JSON.parse(post.body)).toMatchObject({ stopReason });
  }
);

test("the payload carries only the session, stop reason and duration", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({
    baseUrl: ntfy.baseUrl,
    topic: "t",
  });
  gateway.current = { ...gateway.current, id: "s7", name: "refactor auth" };
  gateway.emit({ name: "runStarted" });
  gateway.emit({ name: "userMessage", text: "my secret prompt" });
  gateway.emit({ name: "messageEnd", text: "secret answer", thinking: "" });
  gateway.emit({
    name: "runSettled",
    stopReason: "error",
    errorMessage: "secret failure detail",
  });

  const post = await ntfy.firstPost();

  expect(JSON.parse(post.body)).toEqual({
    sessionId: "s7",
    sessionName: "refactor auth",
    stopReason: "error",
    durationMs: expect.any(Number),
  });
});

test("an unnamed session is announced without a name", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({ baseUrl: ntfy.baseUrl, topic: "t" });

  runThrough(gateway, "success");

  const post = await ntfy.firstPost();
  expect(JSON.parse(post.body)).not.toHaveProperty("sessionName");
});

test("a base URL with a trailing slash still reaches the topic", async () => {
  const ntfy = await fakeNtfy();
  const gateway = await bridgeNotifying({
    baseUrl: `${ntfy.baseUrl}/`,
    topic: "t",
  });

  runThrough(gateway, "success");

  expect((await ntfy.firstPost()).url).toBe("/t");
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
