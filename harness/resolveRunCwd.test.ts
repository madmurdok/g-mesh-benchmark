import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resetResolvedRevisionsCache, resolveWarm } from "./lib/corpusResolver.js";
import type { RunCwdDeps } from "./token-economy.js";
import { resolveRunCwd } from "./token-economy.js";
import type { BenchTask, CorpusEntry } from "./lib/types.js";

/**
 * Covers GMB-155's core ordering guarantee: for a task carrying `seedFiles`,
 * resolveRunCwd() copies the seed into the *run's own* clone (never the
 * shared resolveWarm cache), and does so before any g-mesh warm-up/map step
 * for arms that need one — an index or map built before the seed lands would
 * describe a tree the agent never actually sees.
 *
 * Real git against a throwaway source repo, same pattern as
 * lib/corpusResolver.test.ts: the bug this covers is about which directory a
 * file ends up in and in what order calls happen, not something a git mock
 * could stand in for.
 *
 * Run: npx tsx --test harness/resolveRunCwd.test.ts
 * (no test runner is wired into package.json in this repo.)
 */

const CACHE_ROOT = path.join(tmpdir(), "gmesh-bench-corpora");
const trash: string[] = [];

function cleanup(): void {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetResolvedRevisionsCache();
}

/** A one-commit source repo, pinned by its own resolved SHA so no test depends on an unpinned-corpus warning. */
function makeSourceRepo(): { repoPath: string; revision: string } {
  const repoPath = mkdtempSync(path.join(tmpdir(), "gmesh-bench-src-"));
  trash.push(repoPath);
  const git = (...args: string[]) => execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "bench@example.test");
  git("config", "user.name", "bench");
  writeFileSync(path.join(repoPath, "marker.txt"), "unseeded\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  const revision = git("rev-parse", "HEAD");
  return { repoPath, revision };
}

function localEntry(id: string, repoPath: string, revision: string): CorpusEntry {
  return { id, kind: "local", path: repoPath, revision, language: "ts" };
}

/**
 * Any file guaranteed to exist in this repo and cheap to read — the seed's
 * *content* doesn't matter to any of these tests, only that copying it
 * succeeds and lands at the requested destination. Same fixture
 * testRunner.test.ts/fixtureFiles.test.ts already use, for the same reason.
 */
const SEED_SRC = "corpora/task-tracker-mcp/fixtures/tt-implement-release-cancelled-task-bug/release-cancelled.test.ts";
const SEED_DEST = "seeded/marker.test.ts";

function seededTask(id: string): BenchTask {
  return {
    id,
    kind: "implement",
    target: { symbol: "", file: "" },
    prompt: "",
    oracle: {},
    seedFiles: { [SEED_DEST]: SEED_SRC },
  };
}

const noopDeps: RunCwdDeps = {
  warmGmeshIndex: async () => undefined,
  writeRepoMap: async () => undefined,
};

test("resolveRunCwd puts the seed in the run's own clone, never in the shared resolveWarm cache", async (t) => {
  t.after(cleanup);
  const { repoPath, revision } = makeSourceRepo();
  const id = `resolve-run-cwd-plain-${process.pid}-${Date.now()}`;
  const entry = localEntry(id, repoPath, revision);
  trash.push(path.join(CACHE_ROOT, id));

  const runDest = await resolveRunCwd("baseline", entry, seededTask(id), noopDeps);
  trash.push(runDest);
  const seeded = readFileSync(path.join(runDest, SEED_DEST), "utf-8");
  assert.match(seeded, /releaseTask/);

  // Same corpus, the harness's reused warm checkout — resolveRunCwd must
  // never have touched it, so a seed placed in a run clone can't leak into
  // whatever later task or repetition reuses this cache path.
  resetResolvedRevisionsCache();
  const warmDest = await resolveWarm(entry);
  assert.equal(existsSync(path.join(warmDest, SEED_DEST)), false);
});

test("resolveRunCwd seeds a gmesh-configured clone before warming its g-mesh index", async (t) => {
  t.after(cleanup);
  const { repoPath, revision } = makeSourceRepo();
  const id = `resolve-run-cwd-warm-order-${process.pid}-${Date.now()}`;
  const entry = localEntry(id, repoPath, revision);

  const order: string[] = [];
  const deps: RunCwdDeps = {
    warmGmeshIndex: async (cwd) => {
      order.push(existsSync(path.join(cwd, SEED_DEST)) ? "warm-sees-seed" : "warm-before-seed");
    },
    writeRepoMap: async () => undefined,
  };

  const dest = await resolveRunCwd("gmesh-configured", entry, seededTask(id), deps);
  trash.push(dest);

  assert.deepEqual(order, ["warm-sees-seed"], "the seed must be on disk by the time warmGmeshIndex is called");
});

test("resolveRunCwd seeds a gmesh-configured-map clone before warming and before writing the map", async (t) => {
  t.after(cleanup);
  const { repoPath, revision } = makeSourceRepo();
  const id = `resolve-run-cwd-map-order-${process.pid}-${Date.now()}`;
  const entry = localEntry(id, repoPath, revision);

  const order: string[] = [];
  const deps: RunCwdDeps = {
    warmGmeshIndex: async (cwd) => {
      order.push(existsSync(path.join(cwd, SEED_DEST)) ? "warm-sees-seed" : "warm-before-seed");
    },
    writeRepoMap: async (cwd) => {
      order.push(existsSync(path.join(cwd, SEED_DEST)) ? "map-sees-seed" : "map-before-seed");
    },
  };

  const dest = await resolveRunCwd("gmesh-configured-map", entry, seededTask(id), deps);
  trash.push(dest);

  assert.deepEqual(order, ["warm-sees-seed", "map-sees-seed"]);
});

test("a task with no seedFiles is unaffected: resolveRunCwd never calls the warm/map deps for a plain arm", async (t) => {
  t.after(cleanup);
  const { repoPath, revision } = makeSourceRepo();
  const id = `resolve-run-cwd-no-seed-${process.pid}-${Date.now()}`;
  const entry = localEntry(id, repoPath, revision);

  let calls = 0;
  const deps: RunCwdDeps = {
    warmGmeshIndex: async () => {
      calls += 1;
    },
    writeRepoMap: async () => {
      calls += 1;
    },
  };
  const task: BenchTask = { id, kind: "implement", target: { symbol: "", file: "" }, prompt: "", oracle: {} };

  const dest = await resolveRunCwd("baseline", entry, task, deps);
  trash.push(dest);

  assert.equal(existsSync(path.join(dest, SEED_DEST)), false);
  assert.equal(calls, 0);
});
