import assert from "node:assert/strict";
import test from "node:test";
import type { TokenEconomyRun } from "../token-economy.js";
import {
  aggregateGroup,
  computeAggregate,
  computeAnalysis,
  computeCategoryTokenBreakdown,
  computeCategoryTokenTable,
  computeCorrectnessTable,
  computeTaskTable,
  pairedTokenTotals,
  primaryComparisonArm,
  UNCATEGORIZED,
} from "./reportData.js";
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
  expectedWinner?: TokenEconomyRun["expectedWinner"];
}): TokenEconomyRun {
  return {
    taskId: overrides.taskId ?? `task-${seq++}`,
    corpusId: "c",
    arm: overrides.arm,
    repetition: overrides.repetition ?? 1,
    timestamp: "2026-07-31T00:00:00.000Z",
    model: "claude-sonnet-5",
    category: overrides.category,
    expectedWinner: overrides.expectedWinner,
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

// --- primaryComparisonArm: which arm the headline numbers compare ------------

test("primaryComparisonArm picks the highest-ranked non-baseline arm present, in ARM_ORDER", () => {
  assert.equal(primaryComparisonArm([run({ arm: "gmesh-configured" }), run({ arm: "baseline" })]), "gmesh-configured");
  // Both present: gmesh-configured outranks bare gmesh (it is the default primary arm).
  assert.equal(
    primaryComparisonArm([run({ arm: "gmesh" }), run({ arm: "baseline" }), run({ arm: "gmesh-configured" })]),
    "gmesh-configured",
  );
  // Pre-swap history: the only non-baseline arm is bare gmesh, so it resolves
  // to exactly the value that used to be hardcoded.
  assert.equal(primaryComparisonArm([run({ arm: "gmesh" }), run({ arm: "baseline" })]), "gmesh");
  // Further down ARM_ORDER, each only when nothing above it is present.
  assert.equal(primaryComparisonArm([run({ arm: "baseline" }), run({ arm: "gmesh-trusted" })]), "gmesh-trusted");
  assert.equal(primaryComparisonArm([run({ arm: "baseline" }), run({ arm: "kungfu-configured" })]), "kungfu-configured");
  assert.equal(primaryComparisonArm([run({ arm: "kungfu" }), run({ arm: "kungfu-configured" })]), "kungfu");
});

test("primaryComparisonArm is undefined when there is nothing to compare baseline against", () => {
  assert.equal(primaryComparisonArm([]), undefined);
  assert.equal(primaryComparisonArm([run({ arm: "baseline" }), run({ arm: "baseline" })]), undefined);
});

// --- headline aggregates: the gmesh-configured bug and its back-compat ------

/** One (task, rep) pair per arm, so every headline function has something to pair. */
function twoArmRuns(primaryArm: Arm): TokenEconomyRun[] {
  return [
    run({ taskId: "t1", arm: primaryArm, category: "lookup", cacheReadTokens: 8000, numTurns: 4 }),
    run({ taskId: "t1", arm: "baseline", category: "lookup", cacheReadTokens: 10000, numTurns: 9 }),
    run({ taskId: "t2", arm: primaryArm, category: "multi-hop", cacheReadTokens: 12000, numTurns: 5 }),
    run({ taskId: "t2", arm: "baseline", category: "multi-hop", cacheReadTokens: 20000, numTurns: 14 }),
  ];
}

test("a gmesh-configured run set produces real headline numbers instead of the all-zeros the hardcoded arm gave", () => {
  // The bug: every function below hardcoded the literal "gmesh", so a run set
  // whose primary arm is gmesh-configured silently reported pairCount 0 /
  // "across 0 compared tasks" while the per-task table showed real data.
  const runs = twoArmRuns("gmesh-configured");

  const paired = pairedTokenTotals(runs);
  assert.equal(paired.arm, "gmesh-configured");
  assert.equal(paired.pairCount, 2);
  assert.equal(paired.totalGmesh, 20000);
  assert.equal(paired.totalBaseline, 30000);

  const aggregate = computeAggregate(runs);
  assert.equal(aggregate.arm, "gmesh-configured");
  assert.equal(aggregate.taskCount, 2);
  assert.equal(aggregate.totalGmeshTokens, 20000);
  assert.equal(aggregate.totalBaselineTokens, 30000);
  assert.equal(aggregate.gmeshOracleOk, 2);
  assert.equal(aggregate.baselineOracleOk, 2);

  const categoryRows = computeCategoryTokenTable(runs);
  assert.deepEqual(categoryRows.map((r) => r.category), ["lookup", "multi-hop"]);
  assert.ok(categoryRows.every((r) => r.arm === "gmesh-configured"));
  assert.equal(categoryRows[0]!.gmeshMeanTokens, 8000);

  const breakdownArms = [...new Set(computeCategoryTokenBreakdown(runs).map((r) => r.arm))].sort();
  assert.deepEqual(breakdownArms, ["baseline", "gmesh-configured"]);
});

test("a legacy gmesh/baseline run set is byte-identical to what the hardcoded arm produced", () => {
  // Backward-compatibility guard: report.ts is routinely re-run over historical
  // results/token-economy/*.json files recorded before gmesh-configured
  // existed. Their numbers must not move. The expected values below are the
  // ones the hardcoded-"gmesh" implementation produced for this fixture.
  const runs = twoArmRuns("gmesh");

  const paired = pairedTokenTotals(runs);
  assert.equal(paired.arm, "gmesh");
  assert.equal(paired.pairCount, 2);
  assert.equal(paired.totalGmesh, 20000);
  assert.equal(paired.totalBaseline, 30000);

  const aggregate = computeAggregate(runs);
  assert.equal(aggregate.arm, "gmesh");
  assert.equal(aggregate.taskCount, 2);
  assert.equal(aggregate.unconditionalReductionPct, (10000 / 30000) * 100);

  const bullets = computeAnalysis(runs, computeCorrectnessTable(runs), computeTaskTable(runs), aggregate, paired);
  // The bottom-line bullet is the string the findings docs and the LLM
  // narrative are written against — for legacy data it must still say "gmesh".
  assert.ok(bullets.at(-1)!.startsWith("Bottom line: across 2 compared tasks, gmesh used 33.3% fewer tokens"));
  assert.ok(bullets.at(-1)!.includes("Oracle pass rate — gmesh: 2/2 (100%), baseline: 2/2 (100%)"));
});

test("the bottom-line bullet names the arm it actually measured, not a hardcoded 'gmesh'", () => {
  const runs = twoArmRuns("gmesh-configured");
  const aggregate = computeAggregate(runs);
  const bullets = computeAnalysis(runs, computeCorrectnessTable(runs), computeTaskTable(runs), aggregate, pairedTokenTotals(runs));

  const bottomLine = bullets.at(-1)!;
  assert.ok(bottomLine.startsWith("Bottom line: across 2 compared tasks, gmesh-configured used 33.3% fewer tokens"));
  assert.ok(bottomLine.includes("Oracle pass rate — gmesh-configured: 2/2"));
});

test("when both g-mesh arms ran, the headline follows gmesh-configured and ignores the bare-gmesh runs", () => {
  // A cumulative report over all history contains both. ARM_ORDER decides, and
  // the losing arm must not leak into the primary totals.
  const runs = [
    ...twoArmRuns("gmesh-configured"),
    run({ taskId: "t1", arm: "gmesh", category: "lookup", cacheReadTokens: 999_999 }),
    run({ taskId: "t2", arm: "gmesh", category: "multi-hop", cacheReadTokens: 999_999 }),
  ];

  const paired = pairedTokenTotals(runs);
  assert.equal(paired.arm, "gmesh-configured");
  assert.equal(paired.totalGmesh, 20000);
  assert.equal(computeAggregate(runs).totalGmeshTokens, 20000);
});

test("a category missing the primary arm is dropped, never silently compared against a different arm", () => {
  const runs = [
    ...twoArmRuns("gmesh-configured"),
    // "control" has only bare-gmesh vs baseline — it predates the primary arm.
    run({ taskId: "t3", arm: "gmesh", category: "control", cacheReadTokens: 1000 }),
    run({ taskId: "t3", arm: "baseline", category: "control", cacheReadTokens: 2000 }),
  ];

  const categories = computeCategoryTokenTable(runs).map((r) => r.category);
  assert.deepEqual(categories, ["lookup", "multi-hop"]);
  assert.deepEqual(computeCategoryTokenBreakdown(runs).map((r) => r.category), [
    "lookup",
    "lookup",
    "multi-hop",
    "multi-hop",
  ]);
});

test("a baseline-only run set degrades exactly as before: zeros, labelled gmesh, no crash", () => {
  const runs = [run({ taskId: "t1", arm: "baseline", cacheReadTokens: 5000 })];
  const aggregate = computeAggregate(runs);

  assert.equal(aggregate.arm, "gmesh");
  assert.equal(aggregate.taskCount, 0);
  assert.equal(aggregate.unconditionalReductionPct, 0);
  assert.equal(pairedTokenTotals(runs).pairCount, 0);
  assert.equal(computeCategoryTokenTable(runs).length, 0);
});

test("the expected-winner and parity bullets pair against the primary arm", () => {
  const runs = [
    run({ taskId: "t1", arm: "gmesh-configured", expectedWinner: "gmesh", cacheReadTokens: 1000 }),
    run({ taskId: "t1", arm: "baseline", expectedWinner: "gmesh", cacheReadTokens: 4000 }),
    run({ taskId: "t2", arm: "gmesh-configured", expectedWinner: "parity", cacheReadTokens: 1000 }),
    run({ taskId: "t2", arm: "baseline", expectedWinner: "parity", cacheReadTokens: 4000 }),
  ];
  const aggregate = computeAggregate(runs);
  const bullets = computeAnalysis(runs, computeCorrectnessTable(runs), computeTaskTable(runs), aggregate, pairedTokenTotals(runs));

  // Previously both bullets went missing entirely: perTaskPairedMeans found no
  // bare-"gmesh" run and returned null for every task.
  assert.ok(bullets.some((b) => b.startsWith("Expected-winner check: 1/1 tasks")));
  const parity = bullets.find((b) => b.includes('expectedWinner:"parity"'))!;
  assert.ok(parity.includes("(gmesh-configured 1000, baseline 4000)"));
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
