import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { regressionPathsIn, runAcceptanceTest } from "./testRunner.js";

/**
 * Any file that's guaranteed to exist in this repo and is cheap to read — the
 * point of these tests is the copy/spawn plumbing, not the fixture's contents.
 */
const HOLDOUT_SRC =
  "corpora/task-tracker-mcp/fixtures/tt-implement-release-cancelled-task-bug/release-cancelled.test.ts";

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
    assert.match(copied, /releaseTask/);
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

/**
 * GMB-153: the regression half of a test-mode oracle is restored from HEAD so
 * the oracle grades the agent's implementation, not the tests the agent wrote
 * about it. The two `runAcceptanceTest` cases below are the discriminating
 * pair the standing rule asks for - one where the mechanism must now change
 * the verdict, one where it must not.
 */

const execFileAsync = promisify(execFile);

/** A clone-shaped fixture: a real git repo with one committed test file. */
async function withGitCwd(committed: string, fn: (cwd: string) => Promise<void>): Promise<void> {
  await withTempCwd(async (cwd) => {
    await execFileAsync("git", ["-C", cwd, "init", "-q"]);
    await execFileAsync("git", ["-C", cwd, "config", "user.email", "t@example.com"]);
    await execFileAsync("git", ["-C", cwd, "config", "user.name", "t"]);
    await mkdir(path.join(cwd, "tests"), { recursive: true });
    await writeFile(path.join(cwd, "tests/regression.test.ts"), committed);
    await execFileAsync("git", ["-C", cwd, "add", "tests/regression.test.ts"]);
    await execFileAsync("git", ["-C", cwd, "commit", "-q", "-m", "corpus"]);
    await fn(cwd);
  });
}

test("regressionPathsIn: picks the real corpus command's regression files and drops its holdout", () => {
  const command =
    "npm ci --no-audit --no-fund --silent && npx vitest run tests/lifecycle.test.ts " +
    "tests/status.test.ts tests/ownership.test.ts tests/__bench_holdout__/release-cancelled.test.ts";
  assert.deepEqual(regressionPathsIn(command, ["tests/__bench_holdout__/release-cancelled.test.ts"]), [
    "tests/lifecycle.test.ts",
    "tests/status.test.ts",
    "tests/ownership.test.ts",
  ]);
});

test("regressionPathsIn: flags and bare package names are never mistaken for paths", () => {
  assert.deepEqual(regressionPathsIn("npm ci --no-audit --silent && npx vitest run", []), []);
});

test("a broken test the AGENT added to a tracked file no longer fails the oracle", async () => {
  await withGitCwd('process.exit(0);\n', async (cwd) => {
    // Stand-in for the agent appending its own it(...) and getting it wrong -
    // exactly what all three arms did on tt-implement-release-cancelled-task-bug.
    await writeFile(path.join(cwd, "tests/regression.test.ts"), 'process.exit(1);\n');

    const result = await runAcceptanceTest(cwd, {
      mode: "test",
      holdoutFiles: {},
      testCommand: "node tests/regression.test.ts",
    });

    assert.equal(result.passed, true, "the committed version exits 0; the agent's edit must not be graded");
  });
});

test("a broken HOLDOUT still fails the oracle - the restore must not blunt the grader", async () => {
  await withGitCwd('process.exit(0);\n', async (cwd) => {
    const result = await runAcceptanceTest(cwd, {
      mode: "test",
      holdoutFiles: { "tests/__bench_holdout__/acceptance.test.ts": HOLDOUT_SRC },
      // The holdout copied in is a vitest file that node cannot run, so this
      // exits non-zero for a reason that comes from the holdout, not the agent.
      testCommand: "node tests/regression.test.ts && node tests/__bench_holdout__/acceptance.test.ts",
    });

    assert.equal(result.passed, false);
  });
});

test("a cwd that is not a git repo is graded anyway, with the failure to restore reported", async () => {
  await withTempCwd(async (cwd) => {
    await mkdir(path.join(cwd, "tests"), { recursive: true });
    await writeFile(path.join(cwd, "tests/regression.test.ts"), 'process.exit(0);\n');

    const result = await runAcceptanceTest(cwd, {
      mode: "test",
      testCommand: "node tests/regression.test.ts",
    });

    assert.equal(result.passed, true, "a git failure must not cost a run its verdict");
    assert.match(result.reason, /could not restore tests\/regression\.test\.ts/);
  });
});
