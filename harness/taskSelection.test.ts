import assert from "node:assert/strict";
import test from "node:test";
import { excalidrawImplementationScope, selectTasksForCorpus } from "./token-economy.js";
import type { BenchTask } from "./lib/types.js";

/**
 * Covers which tasks a run actually executes: the G_MESH_BENCH_EXCALIDRAW_SCOPE
 * preset and its interaction with an explicit CLI task selection. Pure
 * functions, so no clone, no install, no API spend.
 *
 * Run: npx tsx harness/taskSelection.test.ts
 * (no test runner is wired into package.json in this repo).
 */

const task = (id: string, category: BenchTask["category"]): BenchTask =>
  ({ id, kind: "implement", category, target: { symbol: "", file: "" }, prompt: "", oracle: {} });

const EX_TASKS: BenchTask[] = [
  task("ex-lookup-something", "lookup"),
  task("ex-implement-library-dedup", "implementation"),
  task("ex-implement-mutateelement-elbow-zero-position", "implementation"),
  task("ex-implement-linear-editor-order-crash", "implementation"),
];

function withScopeEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.G_MESH_BENCH_EXCALIDRAW_SCOPE;
  if (value === undefined) {
    delete process.env.G_MESH_BENCH_EXCALIDRAW_SCOPE;
  } else {
    process.env.G_MESH_BENCH_EXCALIDRAW_SCOPE = value;
  }
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete process.env.G_MESH_BENCH_EXCALIDRAW_SCOPE;
    } else {
      process.env.G_MESH_BENCH_EXCALIDRAW_SCOPE = previous;
    }
  }
}

test("the scope defaults to the single cheapest excalidraw implementation task", () => {
  assert.deepEqual(withScopeEnv(undefined, excalidrawImplementationScope), [
    "ex-implement-mutateelement-elbow-zero-position",
  ]);
});

test("the priciest task is only ever reached by asking for it explicitly", () => {
  // It routinely trips MAX_BUDGET_USD, so a default run must not pay for it.
  for (const preset of ["low", "normal"]) {
    assert.equal(
      withScopeEnv(preset, excalidrawImplementationScope).includes("ex-implement-library-dedup"),
      false,
    );
  }
  assert.equal(
    withScopeEnv("high", excalidrawImplementationScope).includes("ex-implement-library-dedup"),
    true,
  );
});

test("presets are cumulative, cheapest first", () => {
  assert.equal(withScopeEnv("normal", excalidrawImplementationScope).length, 2);
  assert.equal(withScopeEnv("high", excalidrawImplementationScope).length, 3);
});

test("the preset name is case- and whitespace-insensitive", () => {
  assert.equal(withScopeEnv("  HIGH \n", excalidrawImplementationScope).length, 3);
});

test("an unrecognized preset name is rejected rather than silently defaulted", () => {
  assert.throws(() => withScopeEnv("all", excalidrawImplementationScope), /G_MESH_BENCH_EXCALIDRAW_SCOPE/);
});

test("an unfiltered run keeps every non-implementation excalidraw task regardless of scope", () => {
  const selected = selectTasksForCorpus("excalidraw", EX_TASKS, [], [
    "ex-implement-mutateelement-elbow-zero-position",
  ]);
  assert.deepEqual(selected.map((t) => t.id), [
    "ex-lookup-something",
    "ex-implement-mutateelement-elbow-zero-position",
  ]);
});

test("the scope never touches another corpus's implementation tasks", () => {
  const ttTasks = [task("tt-implement-release-cancelled-task-bug", "implementation")];
  const selected = selectTasksForCorpus("task-tracker-mcp", ttTasks, [], [
    "ex-implement-mutateelement-elbow-zero-position",
  ]);
  assert.deepEqual(selected.map((t) => t.id), ["tt-implement-release-cancelled-task-bug"]);
});

test("an explicit CLI selection bypasses the scope entirely", () => {
  // The whole point: asking for a task by name must run it even when the
  // current preset would have left it out of a full run.
  const selected = selectTasksForCorpus(
    "excalidraw",
    EX_TASKS,
    ["ex-implement-library-dedup"],
    ["ex-implement-mutateelement-elbow-zero-position"],
  );
  assert.deepEqual(selected.map((t) => t.id), ["ex-implement-library-dedup"]);
});

test("an explicit selection naming another corpus's task yields nothing here", () => {
  assert.deepEqual(selectTasksForCorpus("excalidraw", EX_TASKS, ["tt-something"], []), []);
});
