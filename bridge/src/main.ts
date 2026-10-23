import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { PiGateway } from "./piGateway.js";
import { startBridge } from "./server.js";

/**
 * Bridge executable. Runs one real pi session in the directory it was started
 * from (discovered resources, stored settings and credentials, as the pi CLI
 * would) and serves it over the Bridge Protocol.
 *
 * Env: `PI_BRIDGE_TOKEN` (required bearer token), `PI_BRIDGE_PORT` (default 8787),
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

// `npm start -w bridge` runs us inside bridge/; INIT_CWD is where npm was invoked.
const cwd = process.env.INIT_CWD ?? process.cwd();
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};
const runtime = await createAgentSessionRuntime(createRuntime, {
  cwd,
  agentDir: getAgentDir(),
  sessionManager: SessionManager.create(cwd),
});
const gateway = new PiGateway(runtime, cwd);
const bridge = await startBridge({
  token,
  port: Number(process.env.PI_BRIDGE_PORT ?? 8787),
  gateway,
  ntfy: ntfy || undefined,
});
console.log(`pi bridge listening on ${bridge.host}:${bridge.port}`);

const shutdown = async () => {
  await bridge.close();
  await gateway.dispose();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
