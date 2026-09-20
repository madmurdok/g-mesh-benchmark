import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This file lives under harness/lib/, one level deeper than token-economy.ts
// (harness/), so it needs an extra ".." to land on the repo root — same
// convention as taskLoader.ts and testRunner.ts.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Copies every (dest, src) pair of `map` into `cwd` — dest relative to `cwd`,
 * src relative to this repo's root (conventionally
 * `corpora/<corpus>/fixtures/<task-id>/...`). One mechanism shared by both
 * fixture kinds this harness has: `oracle.holdoutFiles` (testRunner.ts, copied
 * *after* the agent's turn, for grading) and `BenchTask.seedFiles`
 * (token-economy.ts, copied *before* it, for setup). Same shape, same copy
 * mechanics — only the point in a run's lifecycle differs, and that's each
 * caller's job to get right, not this function's.
 *
 * Fails loudly when a src is missing, rather than writing nothing and moving
 * on: a typo'd fixture path in tasks.json would otherwise look exactly like
 * the agent producing an empty/absent file, which is a much harder bug to
 * track down than a load-time error naming the task's own broken path.
 */
export async function copyFixtureFiles(cwd: string, map: Record<string, string> | undefined): Promise<void> {
  for (const [dest, src] of Object.entries(map ?? {})) {
    const srcPath = path.join(ROOT, src);
    let contents: string;
    try {
      contents = await readFile(srcPath, "utf-8");
    } catch (err) {
      throw new Error(`fixture file missing: ${srcPath} (destination ${dest}): ${(err as Error).message}`);
    }
    const destPath = path.join(cwd, dest);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, contents);
  }
}
