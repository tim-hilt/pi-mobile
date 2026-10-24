import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, expect, test } from "vitest";
import { searchWorkspace } from "./fileSearch.js";

// Git hooks (pre-commit) export GIT_INDEX_FILE etc., which would point test repos at this one.
beforeAll(() => {
  for (const name of Object.keys(process.env))
    if (name.startsWith("GIT_")) delete process.env[name];
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

/** A temp working directory holding empty files at the given relative paths. */
function workspace(...files: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "pi-files-"));
  dirs.push(cwd);
  for (const file of files) {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), "");
  }
  return cwd;
}

test("an empty query lists the shallowest files first", async () => {
  const cwd = workspace("a/b/c/deep.ts", "top.md", "a/mid.ts");

  expect(await searchWorkspace(cwd, "", 10)).toEqual([
    "top.md",
    "a/mid.ts",
    "a/b/c/deep.ts",
  ]);
});

test("matches rank: name prefix, path prefix, substring, then fuzzy", async () => {
  const cwd = workspace(
    "src/server.ts", // name prefix
    "serverless/x.ts", // path prefix
    "lib/mainserver.ts", // substring
    "s/e/r/v/e/r.ts", // subsequence
    "unrelated.ts"
  );

  expect(await searchWorkspace(cwd, "serv", 10)).toEqual([
    "src/server.ts",
    "serverless/x.ts",
    "lib/mainserver.ts",
    "s/e/r/v/e/r.ts",
  ]);
  expect(await searchWorkspace(cwd, "srvr", 10)).toEqual([
    "src/server.ts",
    "s/e/r/v/e/r.ts",
    "serverless/x.ts",
    "lib/mainserver.ts",
  ]);
});

test("matching ignores case and stops at the limit", async () => {
  const cwd = workspace("README.md", "docs/readme-extra.md", "readme.txt");

  expect(await searchWorkspace(cwd, "README", 2)).toEqual([
    "README.md",
    "readme.txt",
  ]);
});

test("without git, dependency and VCS directories are skipped", async () => {
  const cwd = workspace(
    "src/app.ts",
    "node_modules/pkg/app.js",
    ".git/app",
    "build/app.js"
  );

  expect(await searchWorkspace(cwd, "app", 10)).toEqual([
    "src/app.ts",
    "build/app.js",
  ]);
});

test("in a git repository, ignored files are skipped but untracked ones found", async () => {
  const cwd = workspace("tracked.ts", "new.ts", "dist/out.ts");
  writeFileSync(join(cwd, ".gitignore"), "dist/\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "tracked.ts", ".gitignore"], { cwd });

  expect(await searchWorkspace(cwd, ".ts", 10)).toEqual([
    "new.ts",
    "tracked.ts",
  ]);
});
