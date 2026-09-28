import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { ROOT } from "./benchConfig.js";
import type { TokenEconomyRun } from "../token-economy.js";
import {
  aggregateGroup,
  compareArmSpreads,
  computeAggregate,
  computeAnalysis,
  computeCategoryTokenBreakdown,
  computeCategoryTokenTable,
  computeCorrectnessTable,
  computeMcpUnavailableSummary,
  computeSilentMcpArms,
  computeTaskTable,
  computeTierTable,
  computeTokenSpread,
  formatSpreadComparison,
  formatTierComparison,
  formatTokenSpread,
  formatTokenValues,
  MIN_TIER_TASKS_FOR_VERDICT,
  pairedTokenTotals,
  partitionByMcpAvailability,
  primaryComparisonArm,
  UNCATEGORIZED,
  UNTAGGED_TIER,
} from "./reportData.js";
import type { Arm, Tier } from "./types.js";

/** Loads one of GMB-165's real result files from docs/results/gmb165-raw/ — see the GMB-173 test below for why a real record, not a fixture, is required here. */
function loadGmb165RawRecords(filename: string): TokenEconomyRun[] {
  const raw = readFileSync(path.join(ROOT, "docs", "results", "gmb165-raw", filename), "utf8");
  return JSON.parse(raw) as TokenEconomyRun[];
}

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
  corpusId?: string;
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
  mcpServers?: TokenEconomyRun["mcpServers"];
  mcpToolCalls?: number;
  expectedWinner?: TokenEconomyRun["expectedWinner"];
}): TokenEconomyRun {
  return {
    taskId: overrides.taskId ?? `task-${seq++}`,
    corpusId: overrides.corpusId ?? "c",
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
    mcpServers: overrides.mcpServers,
    mcpToolCalls: overrides.mcpToolCalls,
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
    // t1 carries two repetitions per arm (GMB-117: the expected-winner bullet
    // is now spread-gated — see compareArmSpreads — and refuses to judge a
    // single-repetition-per-arm task as insufficient-n, so this fixture needs
    // n>=2 with non-overlapping ranges to exercise a real "matched" verdict).
    run({ taskId: "t1", repetition: 1, arm: "gmesh-configured", expectedWinner: "gmesh", cacheReadTokens: 1000 }),
    run({ taskId: "t1", repetition: 2, arm: "gmesh-configured", expectedWinner: "gmesh", cacheReadTokens: 1200 }),
    run({ taskId: "t1", repetition: 1, arm: "baseline", expectedWinner: "gmesh", cacheReadTokens: 4000 }),
    run({ taskId: "t1", repetition: 2, arm: "baseline", expectedWinner: "gmesh", cacheReadTokens: 4200 }),
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

const CONNECTED = [{ name: "serena", status: "connected" }];
const FAILED = [{ name: "serena", status: "failed" }];

test("a run whose recorded MCP server failed is partitioned out as unavailable", () => {
  // The 2026-08-14 shape: status "ok", oracle passed, and the arm never had its
  // tools. Nothing but mcpServers can tell it apart from a real serena result.
  const dead = run({ taskId: "t1", arm: "serena-configured", mcpServers: FAILED, mcpToolCalls: 0 });
  const live = run({ taskId: "t1", arm: "serena-configured", mcpServers: CONNECTED, mcpToolCalls: 4 });

  const { available, unavailable } = partitionByMcpAvailability([dead, live]);

  assert.deepEqual(available, [live]);
  assert.deepEqual(unavailable, [dead]);
});

test("a connected server with zero calls on one run is available, not unavailable", () => {
  // An arm that had its tools and chose Grep is a real measurement. Only the
  // whole-(arm, corpus) view (computeSilentMcpArms) may convict on zero.
  const { available, unavailable } = partitionByMcpAvailability([
    run({ arm: "serena-configured", mcpServers: CONNECTED, mcpToolCalls: 0 }),
  ]);

  assert.equal(available.length, 1);
  assert.equal(unavailable.length, 0);
});

test("runs predating the mcp fields, and arms with no MCP servers, stay available", () => {
  // undefined is unknown, never a conviction — most of this repo's history has
  // no such field, and baseline legitimately declares no server at all.
  const { available, unavailable } = partitionByMcpAvailability([
    run({ arm: "gmesh" }),
    run({ arm: "baseline", mcpServers: [], mcpToolCalls: 0 }),
  ]);

  assert.equal(available.length, 2);
  assert.equal(unavailable.length, 0);
});

test("computeMcpUnavailableSummary groups excluded runs by arm with the disqualifying status", () => {
  const rows = computeMcpUnavailableSummary([
    run({ arm: "serena-configured", mcpServers: FAILED }),
    run({ arm: "serena-configured", mcpServers: FAILED }),
  ]);

  assert.deepEqual(rows, [{ arm: "serena-configured", count: 2, detail: "serena: failed" }]);
});

test("an arm that connected but never once called an MCP tool is refused", () => {
  // Single corpus throughout (default "c" from run()) — this is the
  // single-corpus case, and its shape must be unaffected by the GMB-173
  // per-(arm, corpus) change: the pair just carries its corpusId now.
  const silent = computeSilentMcpArms([
    run({ arm: "serena-configured", mcpServers: CONNECTED, mcpToolCalls: 0 }),
    run({ arm: "serena-configured", mcpServers: CONNECTED, mcpToolCalls: 0 }),
    run({ arm: "gmesh-configured", mcpServers: [{ name: "g-mesh", status: "connected" }], mcpToolCalls: 2 }),
  ]);

  assert.deepEqual(silent, [{ arm: "serena-configured", corpusId: "c", runsWithData: 2 }]);
});

test("one MCP call anywhere in an arm's history on that corpus clears it", () => {
  assert.deepEqual(
    computeSilentMcpArms([
      run({ arm: "serena-configured", mcpServers: CONNECTED, mcpToolCalls: 0 }),
      run({ arm: "serena-configured", mcpServers: CONNECTED, mcpToolCalls: 1 }),
    ]),
    [],
  );
});

test("baseline and pre-instrumentation runs are never convicted as silent MCP arms", () => {
  // baseline records mcpToolCalls: 0 on every run by construction; a run with no
  // tally at all is unknown. Neither is evidence of anything.
  assert.deepEqual(
    computeSilentMcpArms([
      run({ arm: "baseline", mcpServers: [], mcpToolCalls: 0 }),
      run({ arm: "serena-configured" }),
    ]),
    [],
  );
});

/**
 * GMB-173's discriminating case, built on the real records GMB-165 left in
 * docs/results/gmb165-raw/ rather than an invented fixture — the acceptance
 * criteria ask for exactly this shape: a busy TypeScript corpus mixed with a
 * silent Go one, and the Go one must be raised rather than averaged away.
 *
 * `arm-c-hardened-gin.json`: `gmesh-configured` on the gin (Go) corpus, 6
 * runs, mcpToolCalls: 0 on every single one — genuinely silent, per
 * docs/results/v0.23.0-gmb165-what-the-scope-line-does.md §3 (arm C, "0/6").
 * `verify-shipped-harness-ts-and-py.json`: the same arm on task-tracker-mcp
 * (TypeScript), 3 runs, mcpToolCalls: 1 on every one — busy, per that doc's
 * §7. Pooled by arm alone, the total is 0+1+1+1 = 3, nonzero, and the silent
 * Go half never gets raised — which is the defect GMB-165 §8 named and this
 * task fixes.
 */
test("a busy TypeScript corpus does not average away a silent Go corpus of the same arm (GMB-173, real GMB-165 records)", () => {
  const ginSilent = loadGmb165RawRecords("arm-c-hardened-gin.json");
  const verifyRecords = loadGmb165RawRecords("verify-shipped-harness-ts-and-py.json");
  const ttBusy = verifyRecords.filter((r) => r.corpusId === "task-tracker-mcp");

  // Sanity-check the fixture shape before trusting the assertion below: the
  // gin file really is all-zero, and the task-tracker-mcp slice really is
  // all-nonzero. If either drifts, the test below would stop discriminating
  // anything and should fail loudly here instead of passing for the wrong
  // reason.
  assert.equal(ginSilent.length, 6);
  assert.ok(ginSilent.every((r) => r.mcpToolCalls === 0));
  assert.equal(ttBusy.length, 3);
  assert.ok(ttBusy.every((r) => (r.mcpToolCalls ?? 0) > 0));

  const mixed = [...ginSilent, ...ttBusy];

  // Control: pooling by arm alone (the pre-fix behavior) would sum to a
  // nonzero total and clear the arm entirely — the exact averaging-away this
  // task exists to stop.
  const pooledTotal = mixed.reduce((sum, r) => sum + (r.mcpToolCalls ?? 0), 0);
  assert.ok(pooledTotal > 0, "pooled total must be nonzero for this to be the averaging-away case");

  const silent = computeSilentMcpArms(mixed);

  // Evidence: the fix raises the silent Go corpus specifically...
  assert.deepEqual(
    silent.find((r) => r.corpusId === "gin"),
    { arm: "gmesh-configured", corpusId: "gin", runsWithData: 6 },
  );
  // ...and leaves the busy TypeScript corpus of the same arm alone, unlike a
  // per-arm filter which would have dropped it too.
  assert.equal(
    silent.find((r) => r.corpusId === "task-tracker-mcp"),
    undefined,
  );
  assert.equal(silent.length, 1);
});

// --- GMB-117: report spread, not just medians -------------------------------

test("computeTokenSpread: a single repetition is single-run, never a zero-width range", () => {
  // The central trap: min===max for n=1 is exactly what a real, if narrow,
  // range looks like. A reader must be told "we only ran once", not handed a
  // number that looks like a measured (and suspiciously precise) interval.
  const spread = computeTokenSpread([1000]);
  assert.deepEqual(spread, { kind: "single-run", n: 1, value: 1000 });
});

test("computeTokenSpread: n>=2 is a range, sorted ascending, carrying every raw value", () => {
  const spread = computeTokenSpread([1480, 860, 1155]);
  assert.deepEqual(spread, { kind: "range", n: 3, min: 860, max: 1480, values: [860, 1155, 1480] });
});

test("formatTokenSpread/formatTokenValues render the n=1 case as an explicit statement, not a number", () => {
  // This is the discriminating case: before GMB-117, report.ts printed
  // `agg.bestTokens` and `agg.worstTokens` directly, and for n=1 those are
  // both `Math.min([1000]) === Math.max([1000]) === 1000` — a real report
  // row read "| 1000 | 1000 |", indistinguishable from a genuine
  // zero-variance measurement. See the GMB-117 handoff report for the actual
  // before/after row text captured from a git-worktree control build of the
  // pre-change code (git HEAD 7cd0b4c) against this exact fixture.
  const single = computeTokenSpread([1000]);
  assert.equal(formatTokenSpread(single), "n=1 (single run — no spread)");
  assert.equal(formatTokenValues(single), "1000");
  // Never contains what a zero-width interval would look like.
  assert.ok(!formatTokenSpread(single).includes("1000–1000"));

  const range = computeTokenSpread([860, 1155, 1480]);
  assert.equal(formatTokenSpread(range), "860–1480 (n=3)");
  assert.equal(formatTokenValues(range), "860, 1155, 1480");
});

test("aggregateGroup: an ok run with only one repetition carries tokenSpread.kind 'single-run'", () => {
  const agg = aggregateGroup("t1", "gmesh-configured", [
    run({ taskId: "t1", arm: "gmesh-configured", cacheReadTokens: 1000 }),
  ])!;
  assert.deepEqual(agg.tokenSpread, { kind: "single-run", n: 1, value: 1000 });
});

test("aggregateGroup: multiple ok runs carry a range built from tokensSpent(), not just cacheReadTokens", () => {
  const agg = aggregateGroup("t1", "gmesh-configured", [
    run({ taskId: "t1", arm: "gmesh-configured", cacheReadTokens: 860 }),
    run({ taskId: "t1", arm: "gmesh-configured", cacheReadTokens: 1480 }),
    run({ taskId: "t1", arm: "gmesh-configured", cacheReadTokens: 1155 }),
  ])!;
  assert.equal(agg.tokenSpread.kind, "range");
  assert.deepEqual(agg.tokenSpread, { kind: "range", n: 3, min: 860, max: 1480, values: [860, 1155, 1480] });
});

/** Builds an ArmAggregate-shaped object with just the fields compareArmSpreads reads, for tests that only care about the spread logic. */
function agg(arm: Arm, tokens: number[], meanTokens?: number): { arm: Arm; meanTokens: number; tokenSpread: ReturnType<typeof computeTokenSpread> } {
  return {
    arm,
    meanTokens: meanTokens ?? tokens.reduce((a, b) => a + b, 0) / tokens.length,
    tokenSpread: computeTokenSpread(tokens),
  };
}

test("compareArmSpreads: both arms at n=1 is refused as insufficient-n, regardless of the gap size", () => {
  // REPS=low, both arms: exactly the case the ticket's trap #1 names — "never
  // for before/after token numbers". A 10x-looking gap on a single run each
  // is still not evidence, because neither run's own variability is known.
  assert.deepEqual(compareArmSpreads(agg("gmesh-configured", [7112]) as any, agg("baseline", [3562]) as any), {
    kind: "insufficient-n",
  });
});

test("compareArmSpreads: a bimodal split with overlapping per-arm ranges reads as within noise (the feature-request '2x gap' shape, GMB-117 task #194)", () => {
  // Reconstructs task #194's finding: 12 measurements split 3/3 INSIDE each
  // arm between a low cluster (~245-1364) and a high cluster (~2996-5001),
  // so each arm's own range already spans both clusters and the two arms'
  // ranges overlap almost entirely — a mean/median difference here is a
  // coin-flip artifact, not a real gap.
  const gmesh = agg("gmesh-configured", [300, 1200, 1300, 3000, 4200, 5001]);
  const baseline = agg("baseline", [245, 1000, 1364, 2996, 3800, 4900]);
  assert.deepEqual(compareArmSpreads(gmesh as any, baseline as any), { kind: "within-noise" });
});

test("compareArmSpreads: a single-run value entirely outside the other arm's multi-rep range still reads as real (the ambiguous-name win shape)", () => {
  // 684 (one rep) vs 3982/4438 (two reps), separated by an order of
  // magnitude — GMB-117's bar names this exact case as one that "must still
  // read as real" despite one side having only one repetition: there is a
  // known range on the baseline side (3982-4438), and the single primary
  // value never comes close to it, so the separation is real even though the
  // primary arm's own variability is unmeasured.
  const primary = agg("gmesh-configured", [684]);
  const baseline = agg("baseline", [3982, 4438]);
  const result = compareArmSpreads(primary as any, baseline as any);
  assert.deepEqual(result, { kind: "separated", winner: "gmesh-configured" });
});

test("compareArmSpreads: two non-overlapping multi-rep ranges read as real (the high-fanout improvement shape)", () => {
  // 1618-1939 -> 468-741, non-overlapping — GMB-117's bar names this as a
  // case that "must still read as real". gmesh-configured is the improved
  // (lower-token) side, baseline the higher one.
  const primary = agg("gmesh-configured", [468, 600, 741]);
  const baseline = agg("baseline", [1618, 1780, 1939]);
  const result = compareArmSpreads(primary as any, baseline as any);
  assert.deepEqual(result, { kind: "separated", winner: "gmesh-configured" });
});

test("compareArmSpreads: order of arguments doesn't change the verdict", () => {
  const a = agg("gmesh-configured", [1618, 1939]);
  const b = agg("baseline", [468, 741]);
  assert.deepEqual(compareArmSpreads(a as any, b as any), compareArmSpreads(b as any, a as any));
});

test("formatSpreadComparison renders all four states distinctly, never a bare number", () => {
  assert.equal(formatSpreadComparison(null), "-");
  assert.equal(formatSpreadComparison({ kind: "insufficient-n" }), "n=1 vs n=1 — not enough reps to tell from noise");
  assert.equal(formatSpreadComparison({ kind: "within-noise" }), "within noise (ranges overlap)");
  assert.equal(formatSpreadComparison({ kind: "separated", winner: "gmesh-configured" }), "gmesh-configured lower (real gap)");
});

test("computeTaskTable wires a spread-aware comparison per task from the primary-vs-baseline cells", () => {
  const runs = [
    run({ taskId: "t-noise", arm: "gmesh-configured", repetition: 1, cacheReadTokens: 300 }),
    run({ taskId: "t-noise", arm: "gmesh-configured", repetition: 2, cacheReadTokens: 5001 }),
    run({ taskId: "t-noise", arm: "baseline", repetition: 1, cacheReadTokens: 245 }),
    run({ taskId: "t-noise", arm: "baseline", repetition: 2, cacheReadTokens: 4900 }),
    run({ taskId: "t-real", arm: "gmesh-configured", repetition: 1, cacheReadTokens: 468 }),
    run({ taskId: "t-real", arm: "gmesh-configured", repetition: 2, cacheReadTokens: 741 }),
    run({ taskId: "t-real", arm: "baseline", repetition: 1, cacheReadTokens: 1618 }),
    run({ taskId: "t-real", arm: "baseline", repetition: 2, cacheReadTokens: 1939 }),
    run({ taskId: "t-single", arm: "gmesh-configured", repetition: 1, cacheReadTokens: 900 }),
    run({ taskId: "t-single", arm: "baseline", repetition: 1, cacheReadTokens: 100 }),
    run({ taskId: "t-gmesh-only", arm: "gmesh-configured", repetition: 1, cacheReadTokens: 900 }),
  ];
  const table = computeTaskTable(runs);

  const noise = table.find((t) => t.taskId === "t-noise")!;
  assert.deepEqual(noise.comparison, { kind: "within-noise" });

  const real = table.find((t) => t.taskId === "t-real")!;
  assert.deepEqual(real.comparison, { kind: "separated", winner: "gmesh-configured" });

  const single = table.find((t) => t.taskId === "t-single")!;
  assert.deepEqual(single.comparison, { kind: "insufficient-n" });

  // No baseline cell at all for this task — nothing to compare, and that must
  // read as "not compared", not as any of the three real verdicts.
  const gmeshOnly = table.find((t) => t.taskId === "t-gmesh-only")!;
  assert.equal(gmeshOnly.comparison, null);
});

test("computeAnalysis's expected-winner bullet excludes within-noise and insufficient-n tasks from the match/mismatch tally instead of judging them", () => {
  const runs = [
    // t-real: non-overlapping ranges, gmesh-configured lower — matches expectedWinner "gmesh".
    run({ taskId: "t-real", arm: "gmesh-configured", expectedWinner: "gmesh", repetition: 1, cacheReadTokens: 468 }),
    run({ taskId: "t-real", arm: "gmesh-configured", expectedWinner: "gmesh", repetition: 2, cacheReadTokens: 741 }),
    run({ taskId: "t-real", arm: "baseline", expectedWinner: "gmesh", repetition: 1, cacheReadTokens: 1618 }),
    run({ taskId: "t-real", arm: "baseline", expectedWinner: "gmesh", repetition: 2, cacheReadTokens: 1939 }),
    // t-noise: overlapping ranges — must be excluded from the tally, not counted as a mismatch even though the mean favors baseline.
    run({ taskId: "t-noise", arm: "gmesh-configured", expectedWinner: "gmesh", repetition: 1, cacheReadTokens: 300 }),
    run({ taskId: "t-noise", arm: "gmesh-configured", expectedWinner: "gmesh", repetition: 2, cacheReadTokens: 5001 }),
    run({ taskId: "t-noise", arm: "baseline", expectedWinner: "gmesh", repetition: 1, cacheReadTokens: 245 }),
    run({ taskId: "t-noise", arm: "baseline", expectedWinner: "gmesh", repetition: 2, cacheReadTokens: 4900 }),
  ];
  const aggregate = computeAggregate(runs);
  const taskTable = computeTaskTable(runs);
  const bullets = computeAnalysis(runs, computeCorrectnessTable(runs), taskTable, aggregate, pairedTokenTotals(runs));

  const bullet = bullets.find((b) => b.startsWith("Expected-winner check:"))!;
  assert.ok(bullet.startsWith("Expected-winner check: 1/1 tasks"), bullet);
  assert.ok(bullet.includes("1 further task(s) excluded as within noise"), bullet);
});

// --- computeTierTable / formatTierComparison (GMB-179) ---------------------

function tierMap(entries: [string, Tier | undefined][]): Map<string, Tier | undefined> {
  return new Map(entries);
}

test("an untagged task is never folded into 'structural' — it gets its own bucket", () => {
  // Mirrors today's real corpora state: excalidraw/task-tracker-mcp tasks
  // predate GMB-175's tagging and carry no `tier` at all (see the live
  // `report.ts` output captured for GMB-179 — 48 such tasks currently land
  // in this exact bucket, not in "structural").
  const tiers = tierMap([
    ["structural-1", "structural"],
    ["structural-2", "structural"],
    ["structural-3", "structural"],
    ["no-tier-task", undefined],
  ]);
  const rows = computeTierTable([], tiers);

  const structuralRow = rows.find((r) => r.tier === "structural")!;
  assert.equal(structuralRow.taskCount, 3, "the untagged task must not inflate the structural bucket's task count");

  const untaggedRow = rows.find((r) => r.tier === UNTAGGED_TIER)!;
  assert.equal(untaggedRow.taskCount, 1);
  assert.notEqual(UNTAGGED_TIER, "structural");
});

test("MIN_TIER_TASKS_FOR_VERDICT is 3 — today's real semantic bucket (2 tasks) sits just below it", () => {
  // Documents the exact number the GMB-179 ticket calls out: with the
  // corpora as they stand today, `semantic` has 2 tagged tasks (see
  // corpora/gin/tasks.json and corpora/py-requests/tasks.json), one below the
  // floor this file enforces.
  assert.equal(MIN_TIER_TASKS_FOR_VERDICT, 3);
});

test("a tier bucket below MIN_TIER_TASKS_FOR_VERDICT refuses a comparison even when it has qualifying runs to compare", () => {
  // Exactly today's semantic-bucket shape: 2 tagged tasks, each with a
  // clean gmesh-configured/baseline pair that would otherwise average to a
  // real (if thin) savings % — the refusal has to win regardless of whether
  // data happens to exist, because the problem is the task count, not the
  // run count.
  const tiers = tierMap([
    ["sem-1", "semantic"],
    ["sem-2", "semantic"],
  ]);
  const runs = [
    run({ taskId: "sem-1", arm: "gmesh-configured", cacheReadTokens: 500 }),
    run({ taskId: "sem-1", arm: "baseline", cacheReadTokens: 900 }),
    run({ taskId: "sem-2", arm: "gmesh-configured", cacheReadTokens: 400 }),
    run({ taskId: "sem-2", arm: "baseline", cacheReadTokens: 800 }),
  ];

  const rows = computeTierTable(runs, tiers);
  assert.equal(rows.length, 1);
  const [semanticRow] = rows;
  assert.equal(semanticRow!.taskCount, 2);
  assert.deepEqual(semanticRow!.comparison, { kind: "insufficient-tasks", taskCount: 2 });
});

test("a tier bucket at or above MIN_TIER_TASKS_FOR_VERDICT with qualifying pairs renders a real comparison", () => {
  const tiers = tierMap([
    ["str-1", "structural"],
    ["str-2", "structural"],
    ["str-3", "structural"],
  ]);
  const runs = [
    run({ taskId: "str-1", arm: "gmesh-configured", cacheReadTokens: 1000 }),
    run({ taskId: "str-1", arm: "baseline", cacheReadTokens: 2000 }),
    run({ taskId: "str-2", arm: "gmesh-configured", cacheReadTokens: 1000 }),
    run({ taskId: "str-2", arm: "baseline", cacheReadTokens: 2000 }),
    run({ taskId: "str-3", arm: "gmesh-configured", cacheReadTokens: 1000 }),
    run({ taskId: "str-3", arm: "baseline", cacheReadTokens: 2000 }),
  ];

  const rows = computeTierTable(runs, tiers);
  assert.equal(rows.length, 1);
  const [structuralRow] = rows;
  assert.equal(structuralRow!.taskCount, 3);
  assert.deepEqual(structuralRow!.comparison, {
    kind: "comparable",
    arm: "gmesh-configured",
    gmeshMeanTokens: 1000,
    baselineMeanTokens: 2000,
    savingsPct: 50,
    pairCount: 3,
    taskCount: 3,
  });
});

test("a tier bucket at or above the task floor with zero qualifying pairs reports null, not a refusal or a zero", () => {
  // Distinct from "insufficient-tasks": this bucket has enough tagged tasks,
  // it just has no (taskId, rep) pair where both arms ran ok and passed
  // oracle yet — the same "nothing to compare" null TaskRow.comparison uses
  // at task level, not the task-count refusal.
  const tiers = tierMap([
    ["str-1", "structural"],
    ["str-2", "structural"],
    ["str-3", "structural"],
  ]);
  const rows = computeTierTable([], tiers);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.comparison, null);
});

test("formatTierComparison renders the refusal, no-data, and comparable cases as visibly different strings", () => {
  const refusal = formatTierComparison({ kind: "insufficient-tasks", taskCount: 2 });
  const noData = formatTierComparison(null);
  const comparable = formatTierComparison({
    kind: "comparable",
    arm: "gmesh-configured",
    gmeshMeanTokens: 1000,
    baselineMeanTokens: 2000,
    savingsPct: 50,
    pairCount: 3,
    taskCount: 3,
  });

  assert.ok(refusal.includes("insufficient tasks"), refusal);
  assert.ok(refusal.includes("n=2"), refusal);
  assert.ok(noData.includes("no (task, rep) pair"), noData);
  assert.ok(comparable.includes("50.0%"), comparable);
  // The three renderings must never collide — a reader distinguishing "too
  // few tasks" from "no runs yet" from "here's the number" is the entire
  // point of this table.
  assert.notEqual(refusal, noData);
  assert.notEqual(refusal, comparable);
  assert.notEqual(noData, comparable);
});

/**
 * GMB-179 discrimination test: fails before MIN_TIER_TASKS_FOR_VERDICT's gate
 * exists (a naive per-tier table would average today's 2-task semantic
 * bucket into a bare savings % — see this file's comment above for the
 * verified control: setting the floor to 1 makes this assertion fail,
 * confirmed by temporarily editing MIN_TIER_TASKS_FOR_VERDICT's definition
 * and re-running this suite, then restoring it), passes after (the bucket
 * renders as an explicit refusal instead). Asserts on the actual rendered
 * string from formatTierComparison — the thing report.ts and htmlReport.ts
 * both print — not just on the data shape.
 */
test("discrimination: today's real semantic-tier shape (2 tasks, real qualifying runs) renders a refusal string, never a bare percentage", () => {
  const tiers = tierMap([
    ["gin::multihop-service-registration", "semantic"],
    ["py-requests::caching-decision", "semantic"],
  ]);
  const runs = [
    run({ taskId: "gin::multihop-service-registration", arm: "gmesh-configured", cacheReadTokens: 1200 }),
    run({ taskId: "gin::multihop-service-registration", arm: "baseline", cacheReadTokens: 3100 }),
    run({ taskId: "py-requests::caching-decision", arm: "gmesh-configured", cacheReadTokens: 900 }),
    run({ taskId: "py-requests::caching-decision", arm: "baseline", cacheReadTokens: 2600 }),
  ];

  const [semanticRow] = computeTierTable(runs, tiers);
  const rendered = formatTierComparison(semanticRow!.comparison);

  assert.ok(rendered.startsWith("insufficient tasks"), `expected a refusal, got: "${rendered}"`);
  assert.ok(!/%/.test(rendered), `refusal text must not contain a stray savings percentage: "${rendered}"`);
});
