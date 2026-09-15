import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { copyFixtureFiles } from "./fixtureFiles.js";

/**
 * Covers the copy mechanics shared by `oracle.holdoutFiles` and
 * `BenchTask.seedFiles` (GMB-155): nested destinations, multiple entries, an
 * absent map, and a missing src failing loudly instead of silently.
 *
 * Run: npx tsx harness/lib/fixtureFiles.test.ts
 * (no test runner is wired into package.json in this repo).
 */

/**
 * Any file guaranteed to exist in this repo and cheap to read — the point of
 * these tests is the copy plumbing, not the fixture's contents. Same fixture
 * testRunner.test.ts already uses, for the same reason.
 */
const REAL_SRC =
  "corpora/task-tracker-mcp/fixtures/tt-implement-release-cancelled-task-bug/release-cancelled.test.ts";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "gmesh-bench-fixturefiles-"));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("copies into a nested destination, creating parent dirs that don't exist yet", async () => {
  await withTempCwd(async (cwd) => {
    await copyFixtureFiles(cwd, { "a/b/c/seeded.test.ts": REAL_SRC });
    const copied = await readFile(path.join(cwd, "a/b/c/seeded.test.ts"), "utf-8");
    assert.match(copied, /releaseTask/);
  });
});

test("copies every entry of a multi-file map", async () => {
  await withTempCwd(async (cwd) => {
    await copyFixtureFiles(cwd, { "one.ts": REAL_SRC, "nested/two.ts": REAL_SRC });
    assert.ok((await readFile(path.join(cwd, "one.ts"), "utf-8")).length > 0);
    assert.ok((await readFile(path.join(cwd, "nested/two.ts"), "utf-8")).length > 0);
  });
});

test("an undefined map is a no-op, not an error", async () => {
  await withTempCwd(async (cwd) => {
    await assert.doesNotReject(() => copyFixtureFiles(cwd, undefined));
  });
});

test("a missing src throws loudly, naming both the resolved src path and the destination", async () => {
  await withTempCwd(async (cwd) => {
    await assert.rejects(
      () => copyFixtureFiles(cwd, { "dest.ts": "corpora/does-not-exist/fixtures/nope.ts" }),
      /fixture file missing.*does-not-exist.*destination dest\.ts/s,
    );
  });
});
