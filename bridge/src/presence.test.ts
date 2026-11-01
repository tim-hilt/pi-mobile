import { expect, test } from "vitest";
import { createIoregProbe, parsePresence } from "./presence.js";

// Trimmed real `ioreg` output; idle time is in nanoseconds.
const idle = (seconds: number) =>
  `    | |   "HIDIdleTime" = ${seconds * 1_000_000_000}\n`;
const consoleUsers = (extra = "") =>
  `  | "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,${extra}"kCGSSessionUserNameKey"="me"})\n`;

test("a recently used, unlocked Mac is present", () => {
  expect(parsePresence(idle(5) + consoleUsers())).toBe("present");
});

test("a Mac idle for 180 s or more is away", () => {
  expect(parsePresence(idle(179) + consoleUsers())).toBe("present");
  expect(parsePresence(idle(180) + consoleUsers())).toBe("away");
});

test("a locked screen is away however recently the Mac was used", () => {
  expect(
    parsePresence(idle(1) + consoleUsers(`"CGSSessionScreenIsLocked"=Yes,`))
  ).toBe("away");
});

test("output without an idle time or lock is unknown", () => {
  expect(parsePresence("")).toBe("unknown");
  expect(parsePresence("ioreg: command not found")).toBe("unknown");
  expect(parsePresence(consoleUsers())).toBe("unknown");
});

test("the probe reads both ioreg views and parses them together", async () => {
  const probe = createIoregProbe(async () => idle(300) + consoleUsers());
  expect(await probe()).toBe("away");
});

test("a failing ioreg resolves to unknown instead of throwing", async () => {
  const probe = createIoregProbe(async () => {
    throw new Error("spawn ioreg ENOENT");
  });
  expect(await probe()).toBe("unknown");
});
