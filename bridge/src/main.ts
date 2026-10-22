import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { PiGateway } from "./piGateway.js";
import { startBridge } from "./server.js";

/**
 * Bridge executable. Runs one real pi session in the current directory
 * (discovered resources, stored settings and credentials, as the pi CLI would)
 * and serves it over the Bridge Protocol.
 *
 * Env: `PI_BRIDGE_TOKEN` (required bearer token), `PI_BRIDGE_PORT` (default 8787).
 */
const token = process.env.PI_BRIDGE_TOKEN;
if (!token) {
  console.error("PI_BRIDGE_TOKEN is required");
  process.exit(1);
}

const { session } = await createAgentSession({ cwd: process.cwd() });
const gateway = new PiGateway(session);
const bridge = await startBridge({
  token,
  port: Number(process.env.PI_BRIDGE_PORT ?? 8787),
  gateway,
});
console.log(`pi bridge listening on ${bridge.host}:${bridge.port}`);

const shutdown = async () => {
  await bridge.close();
  gateway.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
