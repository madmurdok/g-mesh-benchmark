import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resetResolvedRevisionsCache, resolveCorpusRevision, resolveFresh, resolveWarm } from "./corpusResolver.js";
import type { CorpusEntry } from "./types.js";

/**
 * Covers the revision-pinning half of corpusResolver.ts (task #116): that
 * every arm's checkout of a corpus lands on one commit, and that the reused
 * warm cache is brought onto it instead of staying at whatever it was cloned
 * at months ago.
 *
 * Real git against a throwaway source repo, no mocks: the whole bug being
 * fixed lived in which git commands ran against a directory, so a fake that
 * stands in for git could not have caught it. Every temp dir (source repos,
 * fresh clones, and the one CACHE_ROOT entry the warm test creates under a
 * unique corpus id, never a real corpus's) is removed in teardown.
 *
 * Run: npx tsx --test harness/lib/corpusResolver.test.ts
 * (no test runner is wired into package.json in this repo — see
 * armConfig.test.ts for the same convention.)
 */

const CACHE_ROOT = path.join(tmpdir(), "gmesh-bench-corpora");
const trash: string[] = [];

function cleanup(): void {
  for (const dir of trash.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetResolvedRevisionsCache();
}

/** A source repo with two commits, returning both SHAs (oldest first). */
function makeSourceRepo(): { repoPath: string; first: string; second: string } {
  const repoPath = mkdtempSync(path.join(tmpdir(), "gmesh-bench-src-"));
  trash.push(repoPath);
  const git = (...args: string[]) => execFileSync("git", ["-C", repoPath, ...args], { encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch", "main");
  git("config", "user.email", "bench@example.test");
  git("config", "user.name", "bench");
  execFileSync("bash", ["-c", `echo first > ${path.join(repoPath, "marker.txt")}`]);
  git("add", ".");
  git("commit", "--quiet", "-m", "first");
  const first = git("rev-parse", "HEAD");
  execFileSync("bash", ["-c", `echo second > ${path.join(repoPath, "marker.txt")}`]);
  git("add", ".");
  git("commit", "--quiet", "-m", "second");
  const second = git("rev-parse", "HEAD");
  return { repoPath, first, second };
}

function localEntry(id: string, repoPath: string, revision?: string): CorpusEntry {
  return { id, kind: "local", path: repoPath, revision, language: "ts" };
}

test("an unpinned local corpus resolves its source checkout's current HEAD", async (t) => {
  t.after(cleanup);
  const { repoPath, second } = makeSourceRepo();
  assert.equal(await resolveCorpusRevision(localEntry("unpinned-corpus", repoPath)), second);
});

test("a pinned local corpus resolves the pin, not HEAD", async (t) => {
  t.after(cleanup);
  const { repoPath, first, second } = makeSourceRepo();
  const resolved = await resolveCorpusRevision(localEntry("pinned-corpus", repoPath, first));
  assert.equal(resolved, first);
  assert.notEqual(resolved, second);
});

test("a corpus resolves once per process, so a mid-run commit can't split two arms", async (t) => {
  t.after(cleanup);
  const { repoPath, second } = makeSourceRepo();
  const entry = localEntry("memoized-corpus", repoPath);
  const before = await resolveCorpusRevision(entry);
  // The source repo moves under the run, exactly as the operator's own
  // task-tracker-mcp checkout does during a multi-hour sweep.
  execFileSync("bash", ["-c", `echo third > ${path.join(repoPath, "marker.txt")}`]);
  execFileSync("git", ["-C", repoPath, "commit", "--quiet", "-am", "third"]);
  assert.equal(await resolveCorpusRevision(entry), before);
  assert.equal(before, second);
});

test("a bad pin fails loudly, before anything is cloned", async (t) => {
  t.after(cleanup);
  const { repoPath } = makeSourceRepo();
  await assert.rejects(
    () => resolveCorpusRevision(localEntry("bad-pin-corpus", repoPath, "0".repeat(40))),
    /cannot resolve revision/,
  );
});

test("resolveFresh checks out the pinned revision, not the source's HEAD", async (t) => {
  t.after(cleanup);
  const { repoPath, first } = makeSourceRepo();
  const dest = await resolveFresh(localEntry("fresh-corpus", repoPath, first));
  trash.push(dest);
  assert.equal(readFileSync(path.join(dest, "marker.txt"), "utf8").trim(), "first");
  assert.equal(execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), first);
});

test("resolveWarm reuses its cache directory but refreshes a stale one onto the resolved revision", async (t) => {
  t.after(cleanup);
  const { repoPath, first, second } = makeSourceRepo();
  // A unique id so this never touches a real corpus's cache entry, and so a
  // crashed earlier run of this test can't leave a directory that changes the
  // outcome of this one.
  const id = `bench-test-warm-${process.pid}-${Date.now()}`;
  const cacheDir = path.join(CACHE_ROOT, id);
  trash.push(cacheDir);

  const stale = await resolveWarm(localEntry(id, repoPath, first));
  assert.equal(stale, cacheDir);
  assert.equal(readFileSync(path.join(stale, "marker.txt"), "utf8").trim(), "first");

  // Second run of the harness, same machine, corpus now pinned one commit
  // further along: the same cache path must come back carrying the new commit.
  // Before task #116 this returned the `first`-commit clone untouched while
  // every mkdtemp-cloning arm got `second`.
  resetResolvedRevisionsCache();
  const refreshed = await resolveWarm(localEntry(id, repoPath, second));
  assert.equal(refreshed, cacheDir);
  assert.equal(readFileSync(path.join(refreshed, "marker.txt"), "utf8").trim(), "second");
  assert.equal(execFileSync("git", ["-C", refreshed, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), second);
});

test("resolveWarm discards edits left in the cache by an earlier run", async (t) => {
  t.after(cleanup);
  const { repoPath, first, second } = makeSourceRepo();
  const id = `bench-test-dirty-${process.pid}-${Date.now()}`;
  trash.push(path.join(CACHE_ROOT, id));

  const cached = await resolveWarm(localEntry(id, repoPath, first));
  execFileSync("bash", ["-c", `echo tampered > ${path.join(cached, "marker.txt")}`]);

  resetResolvedRevisionsCache();
  const refreshed = await resolveWarm(localEntry(id, repoPath, second));
  assert.equal(readFileSync(path.join(refreshed, "marker.txt"), "utf8").trim(), "second");
});
