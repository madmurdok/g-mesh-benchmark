import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runAcceptanceTest } from "./testRunner.js";

/**
 * Any file that's guaranteed to exist in this repo and is cheap to read — the
 * point of these tests is the copy/spawn plumbing, not the fixture's contents.
 */
const HOLDOUT_SRC = "corpora/task-tracker-mcp/fixtures/tt-implement-selfdep-temp-id-fix/selfdep-temp-id.test.ts";

async function withTempCwd(fn: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "gmesh-bench-testrunner-"));
  try {
    await fn(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("copies holdout files into the cwd, creating missing parent dirs", async () => {
  await withTempCwd(async (cwd) => {
    const result = await runAcceptanceTest(cwd, {
      mode: "test",
      holdoutFiles: { "tests/__bench_holdout__/acceptance.test.ts": HOLDOUT_SRC },
      testCommand: "true",
    });

    assert.equal(result.passed, true);
    const copied = await readFile(path.join(cwd, "tests/__bench_holdout__/acceptance.test.ts"), "utf-8");
    assert.match(copied, /createTasks/);
  });
});

test("a non-zero exit code fails the run and keeps the output as the reason", async () => {
  await withTempCwd(async (cwd) => {
    const result = await runAcceptanceTest(cwd, {
      mode: "test",
      testCommand: "echo 'to stdout'; echo 'to stderr' >&2; exit 3",
    });

    assert.equal(result.passed, false);
    // Both streams are interleaved into one transcript, since a test runner
    // splits its report across them.
    assert.match(result.reason, /to stdout/);
    assert.match(result.reason, /to stderr/);
  });
});

test("the reason keeps the tail of a long transcript, not the head", async () => {
  await withTempCwd(async (cwd) => {
    const result = await runAcceptanceTest(cwd, {
      // 4000 lines of filler dwarfs the 2000-char cap, so only the end survives.
      testCommand: "for i in $(seq 1 4000); do echo filler-$i; done; echo LAST-LINE; exit 1",
    });

    assert.equal(result.passed, false);
    assert.match(result.reason, /LAST-LINE/);
    assert.doesNotMatch(result.reason, /filler-1$/m);
    assert.ok(result.reason.length <= 2000);
  });
});

test("a spawn failure is a failed run, not a thrown exception", async () => {
  await withTempCwd(async (cwd) => {
    const result = await runAcceptanceTest(cwd, { mode: "test", testCommand: "definitely-not-a-real-command" });
    assert.equal(result.passed, false);
  });
});

test("a test-mode oracle with no testCommand fails instead of silently passing", async () => {
  await withTempCwd(async (cwd) => {
    const result = await runAcceptanceTest(cwd, { mode: "test" });
    assert.equal(result.passed, false);
    assert.match(result.reason, /testCommand/);
  });
});
