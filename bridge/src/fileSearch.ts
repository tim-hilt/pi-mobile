import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Directories never worth suggesting when there is no `.gitignore` to consult. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/**
 * Files under `cwd` matching `query`, best first, at most `limit`, as
 * `/`-separated paths relative to `cwd`. Matching is case-insensitive:
 * file-name prefix, then path prefix, then substring, then subsequence
 * ("fuzzy"); ties go to the shorter path. An empty query matches everything.
 */
export async function searchWorkspace(
  cwd: string,
  query: string,
  limit: number
): Promise<string[]> {
  const needle = query.toLowerCase();
  const matches: Array<{ path: string; tier: number }> = [];
  for (const path of await listFiles(cwd)) {
    const tier = matchTier(path.toLowerCase(), needle);
    if (tier !== undefined) matches.push({ path, tier });
  }
  return matches
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.path.length - b.path.length ||
        (a.path < b.path ? -1 : 1)
    )
    .slice(0, limit)
    .map((m) => m.path);
}

/** 0 (best) to 3, or undefined if `needle` does not match `path` (both lower-case). */
function matchTier(path: string, needle: string): number | undefined {
  if (basename(path).startsWith(needle)) return 0;
  if (path.startsWith(needle)) return 1;
  if (path.includes(needle)) return 2;
  let from = 0;
  for (const ch of needle) {
    from = path.indexOf(ch, from) + 1;
    if (from === 0) return undefined;
  }
  return 3;
}

/** Every file in the workspace: git's view (tracked and untracked, minus ignored) if it is a repository. */
async function listFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, maxBuffer: 256 * 1024 * 1024 }
    );
    return stdout.split("\0").filter(Boolean);
  } catch {
    return walk(cwd, "");
  }
}

async function walk(root: string, dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, dir), {
    withFileTypes: true,
  })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name))
        files.push(...(await walk(root, path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}
