import assert from "node:assert/strict";
import test from "node:test";
import { loadTasks } from "./taskLoader.js";
import type { BenchTask } from "./types.js";

/**
 * GMB-179 acceptance: `tier` is typed on `BenchTask`, and — with the type no
 * longer looking away (GMB-175 wrote the tag before this field existed) — a
 * mistyped `tier` is now a compile error at any site that annotates a value
 * as `BenchTask`.
 *
 * "Validates" is a compile-time-only claim in this codebase — same stance
 * types.ts already states for `Arm`/`CorpusLanguage`, and the same thing
 * GMB-164's `CorpusEntry` `language` test (taskLoader.test.ts) demonstrates:
 * the `: BenchTask` annotation below is what makes a bad `tier` a `tsc`
 * failure rather than a silent pass. It is NOT a runtime validation
 * boundary: taskLoader.ts's `loadTasks()` reads `corpora/*.json` through
 * `JSON.parse(...) as BenchTask[]`, and an `as` cast from `any` skips
 * TypeScript's excess-property/literal check entirely — a malformed `tier`
 * sitting in the JSON itself is not caught by this declaration at load time.
 * The two negative cases below exist to prove the type *would* catch it at
 * the one place it's actually checked: a `BenchTask`-typed literal.
 */

const baseTask = {
  id: "probe-task",
  kind: "lookup",
  target: { symbol: "Foo", file: "foo.ts" },
  prompt: "probe",
  oracle: {},
} as const;

test("a BenchTask literal with tier omitted still typechecks (untagged is a valid BenchTask)", () => {
  const task: BenchTask = { ...baseTask };
  assert.equal(task.tier, undefined);
});

test("a BenchTask literal with tier: \"structural\" typechecks", () => {
  const task: BenchTask = { ...baseTask, tier: "structural" };
  assert.equal(task.tier, "structural");
});

test("a BenchTask literal with tier: \"semantic\" typechecks", () => {
  const task: BenchTask = { ...baseTask, tier: "semantic" };
  assert.equal(task.tier, "semantic");
});

test("a BenchTask literal with a trailing-space tier is rejected by tsc, not silently accepted", () => {
  // @ts-expect-error — "semantic " (trailing space) is not assignable to Tier ("structural" | "semantic").
  // If this line stops erroring (e.g. `tier` regresses to a bare `string`),
  // `tsc --noEmit` fails here with "Unused '@ts-expect-error' directive" —
  // the demonstration is self-checking, not just documentation.
  const task: BenchTask = { ...baseTask, tier: "semantic " };
  // Runtime never gets a chance to reject this — the point is the line above
  // does not compile at all, which is the demonstration this test exists for.
  void task;
});

test("a BenchTask literal with a misspelled tier is rejected by tsc, not silently accepted", () => {
  // @ts-expect-error — "sematic" (misspelled) is not assignable to Tier ("structural" | "semantic").
  const task: BenchTask = { ...baseTask, tier: "sematic" };
  void task;
});

/**
 * GMB-179 acceptance: "the three tasks.json still load" — loadTasks() reads
 * each corpus's file through the same JSON.parse(...) as BenchTask[] path
 * this task adds the `tier` field to, and must not throw or drop tasks now
 * that BenchTask declares a field none of the pre-GMB-175 corpora had.
 */
test("all three corpora's tasks.json still load after tier is typed on BenchTask", async () => {
  const gin = await loadTasks("gin");
  const pyRequests = await loadTasks("py-requests");
  const ripgrep = await loadTasks("ripgrep");

  assert.ok(gin.length > 0, "gin corpus loaded no tasks");
  assert.ok(pyRequests.length > 0, "py-requests corpus loaded no tasks");
  assert.ok(ripgrep.length > 0, "ripgrep corpus loaded no tasks");

  for (const task of [...gin, ...pyRequests, ...ripgrep]) {
    if (task.tier !== undefined) {
      assert.ok(
        task.tier === "structural" || task.tier === "semantic",
        `task ${task.id} has an unexpected tier value: ${JSON.stringify(task.tier)}`,
      );
    }
  }
});
