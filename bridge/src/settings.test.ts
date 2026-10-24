import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { loadSettings } from "./settings.js";

const dir = () => mkdtempSync(join(tmpdir(), "pi-settings-"));

test("without a settings file the bridge runs locally, without notifications", () => {
  expect(loadSettings(join(dir(), "bridge.json"))).toEqual({
    port: 8787,
    ntfyUrl: "https://ntfy.sh",
  });
});

test("reads public URL, ntfy and port from the settings file", () => {
  const path = join(dir(), "bridge.json");
  writeFileSync(
    path,
    JSON.stringify({
      publicUrl: "wss://pi.example.com",
      ntfyTopic: "t",
      port: 9000,
    })
  );
  expect(loadSettings(path)).toEqual({
    publicUrl: "wss://pi.example.com",
    ntfyTopic: "t",
    ntfyUrl: "https://ntfy.sh",
    port: 9000,
  });
});

test("a malformed settings file is an error, not silently ignored", () => {
  const path = join(dir(), "bridge.json");
  writeFileSync(path, "{nope");
  expect(() => loadSettings(path)).toThrow(path);
});
