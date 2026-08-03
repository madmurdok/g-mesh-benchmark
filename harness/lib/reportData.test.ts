import assert from "node:assert/strict";
import test from "node:test";
import type { TokenEconomyRun } from "../token-economy.js";
import { aggregateGroup, computeCategoryTokenBreakdown, UNCATEGORIZED } from "./reportData.js";
import type { Arm } from "./types.js";

/**
 * Covers computeCategoryTokenBreakdown without spending API money — it is a
 * pure function of a run set, so the pairing/filtering rules that make its
 * numbers mean what the report says they mean are exercised with fixtures.
 *
 * Run: npx tsx harness/lib/reportData.test.ts
 * (no test runner is wired into package.json in this repo — see
 * sessionReport.test.ts for the same convention.)
 */

let seq = 0;

function run(overrides: {
  taskId?: string;
  arm: Arm;
  repetition?: number;
  category?: TokenEconomyRun["category"];
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  status?: TokenEconomyRun["status"];
  oraclePassed?: boolean;
  numTurns?: number;
  searchToolCalls?: number;
  editToolCalls?: number;
  otherToolCalls?: number;
}): TokenEconomyRun {
  return {
    taskId: overrides.taskId ?? `task-${seq++}`,
    corpusId: "c",
    arm: overrides.arm,
    repetition: overrides.repetition ?? 1,
    timestamp: "2026-07-31T00:00:00.000Z",
    model: "claude-sonnet-5",
    category: overrides.category,
    taskDefHash: "hash",
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    numTurns: overrides.numTurns ?? 1,
    searchToolCalls: overrides.searchToolCalls,
    editToolCalls: overrides.editToolCalls,
    otherToolCalls: overrides.otherToolCalls,
    durationMs: 1,
    costUsd: 0,
    judgeCostUsd: 0,
    resultText: "",
    oraclePassed: overrides.oraclePassed ?? true,
    status: overrides.status ?? "ok",
  };
}

test("means each of the four token fields separately per category x arm, over the paired oracle-passed runs", () => {
  const rows = computeCategoryTokenBreakdown([
    run({ taskId: "t1", arm: "gmesh", category: "lookup", inputTokens: 6, outputTokens: 700, cacheCreationTokens: 4000, cacheReadTokens: 60000 }),
    run({ taskId: "t1", arm: "baseline", category: "lookup", inputTokens: 4, outputTokens: 500, cacheCreationTokens: 4000, cacheReadTokens: 40000 }),
    run({ taskId: "t2", arm: "gmesh", category: "lookup", inputTokens: 6, outputTokens: 760, cacheCreationTokens: 5000, cacheReadTokens: 60400 }),
    run({ taskId: "t2", arm: "baseline", category: "lookup", inputTokens: 6, outputTokens: 640, cacheCreationTokens: 4200, cacheReadTokens: 41000 }),
  ]);

  assert.equal(rows.length, 2);
  const gmesh = rows.find((r) => r.arm === "gmesh")!;
  const baseline = rows.find((r) => r.arm === "baseline")!;

  assert.equal(gmesh.category, "lookup");
  assert.equal(gmesh.pairCount, 2);
  assert.equal(gmesh.meanInputTokens, 6);
  assert.equal(gmesh.meanOutputTokens, 730);
  assert.equal(gmesh.meanCacheCreationTokens, 4500);
  assert.equal(gmesh.meanCacheReadTokens, 60200);

  assert.equal(baseline.pairCount, 2);
  assert.equal(baseline.meanCacheCreationTokens, 4100);
  assert.equal(baseline.meanCacheReadTokens, 40500);
});

test("a run with no oraclePassed match on the other arm is excluded from both arms' means", () => {
  const rows = computeCategoryTokenBreakdown([
    run({ taskId: "t1", arm: "gmesh", category: "multi-hop", cacheCreationTokens: 6000, oraclePassed: true }),
    run({ taskId: "t1", arm: "baseline", category: "multi-hop", cacheCreationTokens: 18000, oraclePassed: false }),
  ]);

  // Neither arm passed both-oracle, so the whole pair is dropped — no row at
  // all for this category, same discipline as computeCategoryTokenTable.
  assert.equal(rows.length, 0);
});

test("a category with zero qualifying pairs is omitted rather than emitted as zero", () => {
  const rows = computeCategoryTokenBreakdown([
    run({ taskId: "t1", arm: "gmesh", category: "control", status: "error" }),
    run({ taskId: "t1", arm: "baseline", category: "control" }),
  ]);
  assert.equal(rows.length, 0);
});

test("runs with no category fall into the shared uncategorized bucket, same as computeCorrectnessTable", () => {
  const rows = computeCategoryTokenBreakdown([
    run({ taskId: "t1", arm: "gmesh", cacheCreationTokens: 100 }),
    run({ taskId: "t1", arm: "baseline", cacheCreationTokens: 200 }),
  ]);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.category === UNCATEGORIZED));
});

test("categories are independent: pairing in one category never borrows runs from another", () => {
  const rows = computeCategoryTokenBreakdown([
    run({ taskId: "t1", arm: "gmesh", category: "lookup", cacheReadTokens: 60000 }),
    run({ taskId: "t1", arm: "baseline", category: "lookup", cacheReadTokens: 40000 }),
    run({ taskId: "t2", arm: "gmesh", category: "multi-hop", cacheCreationTokens: 6000 }),
    run({ taskId: "t2", arm: "baseline", category: "multi-hop", cacheCreationTokens: 18000 }),
  ]);

  const categories = [...new Set(rows.map((r) => r.category))].sort();
  assert.deepEqual(categories, ["lookup", "multi-hop"]);

  const multiHopBaseline = rows.find((r) => r.category === "multi-hop" && r.arm === "baseline")!;
  assert.equal(multiHopBaseline.meanCacheCreationTokens, 18000);
  assert.equal(multiHopBaseline.meanCacheReadTokens, 0);
});

// --- aggregateGroup: turn / tool-call means ---------------------------------

test("means turns and each tool-call bucket over a group's ok runs", () => {
  const agg = aggregateGroup("t1", "gmesh-configured", [
    run({ taskId: "t1", arm: "gmesh-configured", numTurns: 10, searchToolCalls: 8, editToolCalls: 2, otherToolCalls: 0 }),
    run({ taskId: "t1", arm: "gmesh-configured", numTurns: 6, searchToolCalls: 4, editToolCalls: 0, otherToolCalls: 0 }),
  ])!;

  assert.equal(agg.meanNumTurns, 8);
  assert.equal(agg.meanSearchToolCalls, 6);
  assert.equal(agg.meanEditToolCalls, 1);
  assert.equal(agg.meanOtherToolCalls, 0);
});

test("a non-ok run is excluded from the turn and tool-call means, same as from the token means", () => {
  const agg = aggregateGroup("t1", "gmesh-configured", [
    run({ taskId: "t1", arm: "gmesh-configured", numTurns: 4, searchToolCalls: 4 }),
    run({ taskId: "t1", arm: "gmesh-configured", numTurns: 40, searchToolCalls: 40, status: "budget_exceeded" }),
  ])!;

  assert.equal(agg.meanNumTurns, 4);
  assert.equal(agg.meanSearchToolCalls, 4);
});

test("tool-call means are null, not 0, for runs recorded before the harness counted tool calls", () => {
  // "unknown" and "made no search calls" are different claims; a historical
  // cell must not assert the second one.
  const agg = aggregateGroup("t1", "gmesh", [run({ taskId: "t1", arm: "gmesh", numTurns: 5 })])!;

  assert.equal(agg.meanNumTurns, 5);
  assert.equal(agg.meanSearchToolCalls, null);
  assert.equal(agg.meanEditToolCalls, null);
  assert.equal(agg.meanOtherToolCalls, null);
});

test("a group mixing pre- and post-instrumentation runs means only the runs that recorded a tally", () => {
  // Averaging the older runs in as 0 would understate the real figure by
  // exactly the share of history in the group.
  const agg = aggregateGroup("t1", "gmesh", [
    run({ taskId: "t1", arm: "gmesh", numTurns: 9 }),
    run({ taskId: "t1", arm: "gmesh", numTurns: 9, searchToolCalls: 7, editToolCalls: 0, otherToolCalls: 0 }),
  ])!;

  assert.equal(agg.meanSearchToolCalls, 7);
});
