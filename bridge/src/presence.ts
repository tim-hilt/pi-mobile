import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Whether the user is at the Mac. `unknown` means the state couldn't be read;
 * callers treat it like `away`, so a failing probe never silences a notification.
 */
export type Presence = "away" | "present" | "unknown";

/** Reads the current presence. Never throws. */
export type PresenceProbe = () => Promise<Presence>;

/** System idle time from which the user counts as away (Orca's threshold). */
const AWAY_IDLE_NS = 180e9;

/**
 * Presence from `ioreg` output holding `HIDIdleTime` (nanoseconds, from
 * `IOHIDSystem`) and the console user's `CGSSessionScreenIsLocked`: away when
 * the screen is locked or idle ≥ 180 s. Unknown without an idle time.
 */
export function parsePresence(ioreg: string): Presence {
  if (/"CGSSessionScreenIsLocked"\s*=\s*Yes/.test(ioreg)) return "away";
  const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(ioreg)?.[1];
  if (idle === undefined) return "unknown";
  return Number(idle) >= AWAY_IDLE_NS ? "away" : "present";
}

const run = promisify(execFile);
const IOREG = "/usr/sbin/ioreg";
const IOREG_TIMEOUT_MS = 2000;

/** Both `ioreg` views `parsePresence` needs, concatenated. */
async function readIoreg(): Promise<string> {
  const views = [
    ["-c", "IOHIDSystem"],
    ["-n", "Root", "-d1"],
  ];
  const outputs = await Promise.all(
    views.map((args) => run(IOREG, args, { timeout: IOREG_TIMEOUT_MS }))
  );
  return outputs.map((o) => o.stdout).join("\n");
}

/** A probe reading macOS state through `read`; any failure resolves to `unknown`. */
export function createIoregProbe(read: () => Promise<string>): PresenceProbe {
  return () => read().then(parsePresence, () => "unknown");
}

/** The production probe: shells out to `ioreg` when asked, never polls. */
export const ioregProbe: PresenceProbe = createIoregProbe(readIoreg);
