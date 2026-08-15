/**
 * cleanCorpora.ts — clears the backlog of throwaway corpus checkouts (and
 * their g-mesh state dirs) this harness leaves under `os.tmpdir()`.
 *
 * Task #16: `resolveFresh()`/`resolveConfigured()` in `harness/lib/
 * corpusResolver.ts` `mkdtemp()` a brand-new checkout for every (task, arm,
 * repetition) that needs one and — deliberately, per that file's own comment
 * on edit-task sandboxes — never deletes it, so a surprising verdict can be
 * examined after the fact. That is the right default for a single run, but
 * across many runs it accumulates: 218 leaked checkouts and 594 g-mesh state
 * dirs were observed on this machine on 2026-08-14/15. This script is the
 * named way to clear that backlog by hand, on demand, rather than something
 * wired into the hot path of every run.
 *
 * What it touches and what it leaves alone:
 *
 * - Targets only `<tmpdir>/gmesh-bench-<corpus-id>-<random>` directories —
 *   the exact shape `mkdtemp(path.join(tmpdir(), "gmesh-bench-${entry.id}-"))`
 *   produces in resolveFresh()/resolveConfigured() (and, by extension,
 *   resolveMapConfigured()/session-economy.ts's serena/kungfu clones, which
 *   all funnel through the same two functions). Never touches anything
 *   outside `os.tmpdir()`.
 * - Leaves `<tmpdir>/gmesh-bench-corpora/` (resolveWarm()'s persistent cache,
 *   named `CACHE_ROOT` in corpusResolver.ts) untouched by default — that
 *   directory is deliberately long-lived, reused across runs specifically to
 *   avoid paying a cold re-index every time. Pass --include-warm-cache to
 *   also clear *just its g-mesh state* (not the checkouts themselves) if you
 *   genuinely want every corpus to cold-start on the next run.
 * - For each target: `g-mesh stop` (in case something is still alive —
 *   should not happen after task #16's fix, but a script clearing a backlog
 *   must not assume the fix always ran), then `g-mesh clean` (deletes the
 *   `~/.g-mesh/projects/<hash>/` state dir `g-mesh clean`'s own docs confirm
 *   it already covers — see g-mesh core/src/cli/clean.rs), then `rm -rf` the
 *   checkout itself (skipped under --include-warm-cache's warm-cache pass).
 *   Every step is best-effort: a directory that never touched g-mesh (a
 *   baseline/kungfu-only clone) has no state dir to clean, and `g-mesh
 *   clean`'s own exit code says so — that is expected, not a failure worth
 *   stopping the sweep over.
 *
 * Usage
 *   npx tsx scripts/cleanCorpora.ts [--dry-run] [--include-warm-cache]
 */

import { execFile } from "node:child_process";
import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gmeshBinaryPath } from "../harness/lib/mcpConfig.js";

const execFileAsync = promisify(execFile);

const CACHE_ROOT_NAME = "gmesh-bench-corpora";
const MCP_CONFIG_PREFIX = "gmesh-bench-mcp-"; // runClaude.ts's per-call temp mcp-config.json dirs — not a corpus checkout, skip.
const THROWAWAY_PREFIX = "gmesh-bench-";

interface Args {
  dryRun: boolean;
  includeWarmCache: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    dryRun: argv.includes("--dry-run"),
    includeWarmCache: argv.includes("--include-warm-cache"),
  };
}

/** Best-effort `g-mesh stop`/`g-mesh clean` against `dir` — logs and swallows failure, same discipline as corpusResolver.ts's stopTrackedGmeshDaemons(). */
async function stopAndCleanGmeshState(dir: string): Promise<void> {
  try {
    await execFileAsync(gmeshBinaryPath(), ["stop"], { cwd: dir });
  } catch (err) {
    console.warn(`  g-mesh stop failed for ${dir}: ${(err as Error).message}`);
  }
  try {
    await execFileAsync(gmeshBinaryPath(), ["clean"], { cwd: dir });
  } catch {
    // Expected whenever this directory never had a g-mesh index at all
    // (a baseline/kungfu/serena-only clone) — not logged as a warning, since
    // that is the common case, not an error.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = tmpdir();
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);

  const throwaways: string[] = [];
  let warmCacheDir: string | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === CACHE_ROOT_NAME) {
      warmCacheDir = path.join(root, entry.name);
      continue;
    }
    if (entry.name.startsWith(MCP_CONFIG_PREFIX)) continue; // not a corpus checkout
    if (entry.name.startsWith(THROWAWAY_PREFIX)) throwaways.push(path.join(root, entry.name));
  }

  console.log(`Found ${throwaways.length} throwaway corpus checkout(s) under ${root}.`);
  for (const dir of throwaways) {
    if (args.dryRun) {
      console.log(`  [dry-run] would stop+clean g-mesh state and rm -rf ${dir}`);
      continue;
    }
    await stopAndCleanGmeshState(dir);
    await rm(dir, { recursive: true, force: true });
    console.log(`  removed ${dir}`);
  }

  if (args.includeWarmCache && warmCacheDir !== undefined) {
    const corpusDirs = await readdir(warmCacheDir, { withFileTypes: true }).catch(() => []);
    console.log(
      `Clearing g-mesh state (not the checkouts) for ${corpusDirs.length} warm-cache corpus dir(s) under ${warmCacheDir}.`,
    );
    for (const entry of corpusDirs) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(warmCacheDir, entry.name);
      if (args.dryRun) {
        console.log(`  [dry-run] would stop+clean g-mesh state for ${dir} (checkout kept)`);
        continue;
      }
      await stopAndCleanGmeshState(dir);
      console.log(`  cleared g-mesh state for ${dir} (checkout kept)`);
    }
  } else if (warmCacheDir !== undefined) {
    const size = await stat(warmCacheDir).catch(() => undefined);
    if (size !== undefined) {
      console.log(
        `Leaving the warm-cache checkout(s) under ${warmCacheDir} untouched (pass --include-warm-cache to also clear their g-mesh state).`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
