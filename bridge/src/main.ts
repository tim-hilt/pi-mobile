import { defaultSocketPath } from "./link.js";
import { listenForShares } from "./linkGateway.js";
import { startBridge } from "./server.js";

/**
 * Bridge executable. Serves every pi session shared over the Share Link (see
 * `shareExtension.ts`) to the app over the Bridge Protocol. Usually started by
 * the first pi that finds none running.
 *
 * Env: `PI_BRIDGE_TOKEN` (required bearer token), `PI_BRIDGE_PORT` (default 8787),
 * `PI_BRIDGE_SOCKET` (default ~/.pi/agent/bridge.sock),
 * `PI_BRIDGE_NTFY_TOPIC` (unguessable topic; settled runs are announced only when set),
 * `PI_BRIDGE_NTFY_URL` (default https://ntfy.sh).
 */
const token = process.env.PI_BRIDGE_TOKEN;
if (!token) {
  console.error("PI_BRIDGE_TOKEN is required");
  process.exit(1);
}

const ntfyTopic = process.env.PI_BRIDGE_NTFY_TOPIC;
const ntfy = ntfyTopic && {
  baseUrl: process.env.PI_BRIDGE_NTFY_URL ?? "https://ntfy.sh",
  topic: ntfyTopic,
};

// The port doubles as the single-instance lock: whoever binds it owns the socket.
const bridge = await startBridge({
  token,
  port: Number(process.env.PI_BRIDGE_PORT ?? 8787),
  ntfy: ntfy || undefined,
}).catch((e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.log("pi bridge already running");
  process.exit(0);
});
const socketPath = defaultSocketPath();
const shares = await listenForShares(socketPath, bridge.hub);
console.log(
  `pi bridge listening on ${bridge.host}:${bridge.port}, sharing via ${socketPath}`
);

const shutdown = async () => {
  await shares.close();
  await bridge.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
