import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** `~/.pi/agent/bridge.json`; every field is optional. */
export interface BridgeSettings {
  /** `wss://` address the app reaches; required for pairing. */
  publicUrl?: string;
  /** Unguessable ntfy topic; settled runs are announced only when set. */
  ntfyTopic?: string;
  ntfyUrl: string;
  /** Local port; doubles as the single-instance lock. */
  port: number;
}

export const defaultSettingsPath = () =>
  join(homedir(), ".pi", "agent", "bridge.json");

export function loadSettings(path = defaultSettingsPath()): BridgeSettings {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    text = "{}";
  }
  let raw: Partial<BridgeSettings>;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  return { ntfyUrl: "https://ntfy.sh", port: 8787, ...raw };
}
