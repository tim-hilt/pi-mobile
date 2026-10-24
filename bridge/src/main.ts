import { randomBytes } from "node:crypto";
import { defaultSocketPath } from "./link.js";
import { listenForShares } from "./linkGateway.js";
import { pairingUrl } from "./pairing.js";
import { startBridge } from "./server.js";
import { loadSettings } from "./settings.js";

/**
 * Bridge executable. Serves every pi session shared over the Share Link (see
 * `shareExtension.ts`) to the app over the Bridge Protocol. Usually started by
 * the first pi that finds none running; configured in `~/.pi/agent/bridge.json`
 * (see `settings.ts`). `PI_BRIDGE_SOCKET` overrides the socket path.
 *
 * The bearer token is random per start and only kept in memory: a restart
 * revokes every paired app. It is never printed; pi shows it as the pairing QR
 * code on `/show-bridge-qr`.
 */
const token = randomBytes(32).toString("hex");
const settings = loadSettings();
const ntfy = settings.ntfyTopic
  ? { baseUrl: settings.ntfyUrl, topic: settings.ntfyTopic }
  : undefined;

// The port doubles as the single-instance lock: whoever binds it owns the socket.
const bridge = await startBridge({
  token,
  port: settings.port,
  ntfy,
}).catch((e: NodeJS.ErrnoException) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.log("pi bridge already running");
  process.exit(0);
});
const socketPath = defaultSocketPath();
const { publicUrl } = settings;
const shares = await listenForShares(socketPath, bridge.hub, {
  pairingUrl: () => publicUrl && pairingUrl(publicUrl, token),
});
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
