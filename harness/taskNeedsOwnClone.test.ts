import assert from "node:assert/strict";
import test from "node:test";
import { EDIT_TOOLS, armTools } from "./lib/armConfig.js";
import type { BenchTask } from "./lib/types.js";
import { taskEditsCode, taskNeedsOwnClone } from "./token-economy.js";

/**
 * Covers GMB-155's split of the old single `taskEditsCode` predicate into two:
 * `taskEditsCode` (still only `oracle.mode === "test"`, still the sole input
 * to `armTools`'s `allowEdit`) and the broader `taskNeedsOwnClone`
 * (`taskEditsCode(task) || hasSeedFiles(task)`, which controls cloning only).
 * A seeded read-only task is the case that motivates the split: it must get
 * its own throwaway clone (so its seed can't leak into a shared one) without
 * getting Edit/Write it was never meant to have.
 *
 * Pure functions, so no clone, no install, no API spend.
 *
 * Run: npx tsx harness/taskNeedsOwnClone.test.ts
 * (no test runner is wired into package.json in this repo).
 */

function baseTask(overrides: Partial<BenchTask> = {}): BenchTask {
  return {
    id: "t1",
    kind: "implement",
    target: { symbol: "", file: "" },
    prompt: "",
    oracle: {},
    ...overrides,
  };
}

test("a plain read-only task (no seedFiles, not mode:'test') needs no own clone", () => {
  const task = baseTask();
  assert.equal(taskEditsCode(task), false);
  assert.equal(taskNeedsOwnClone(task), false);
});

test("an oracle.mode:'test' task needs its own clone and gets Edit/Write", () => {
  const task = baseTask({ oracle: { mode: "test", testCommand: "true" } });
  assert.equal(taskEditsCode(task), true);
  assert.equal(taskNeedsOwnClone(task), true);
  assert.ok(armTools("baseline", { allowEdit: taskEditsCode(task) }).includes(EDIT_TOOLS));
});

test("a seeded read-only task needs its own clone but must NOT get Edit/Write", () => {
  const task = baseTask({ seedFiles: { "seed.ts": "corpora/task-tracker-mcp/fixtures/x/y.ts" } });
  assert.equal(taskEditsCode(task), false, "seeding alone must not grant Edit/Write");
  assert.equal(taskNeedsOwnClone(task), true, "a seed must still force its own clone, to avoid leaking into a shared one");
  assert.ok(
    !armTools("baseline", { allowEdit: taskEditsCode(task) }).includes(EDIT_TOOLS),
    "armTools is driven by taskEditsCode, not taskNeedsOwnClone — a read-only seeded task stays read-only",
  );
});

test("a task that is both mode:'test' and seeded needs its own clone and gets Edit/Write", () => {
  const task = baseTask({
    oracle: { mode: "test", testCommand: "true" },
    seedFiles: { "seed.ts": "corpora/task-tracker-mcp/fixtures/x/y.ts" },
  });
  assert.equal(taskEditsCode(task), true);
  assert.equal(taskNeedsOwnClone(task), true);
  assert.ok(armTools("baseline", { allowEdit: taskEditsCode(task) }).includes(EDIT_TOOLS));
});

test("an empty seedFiles map behaves like no seedFiles at all", () => {
  const task = baseTask({ seedFiles: {} });
  assert.equal(taskNeedsOwnClone(task), false);
});
