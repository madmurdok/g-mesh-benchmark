import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TokenEconomyRun } from "../token-economy.js";
import { ARM_ORDER, type Arm } from "./types.js";

export interface ArmAggregate {
  taskId: string;
  arm: Arm;
  total: number;
  okCount: number;
  passCount: number;
  meanTokens: number;
  bestTokens: number;
  worstTokens: number;
  meanCostUsd: number;
  /** Mean wall-clock duration (ms) over the same ok runs as meanTokens/meanCostUsd. */
  meanDurationMs: number;
  /** Mean over the same ok runs as meanTokens. Context for the tool-call means below: "N turns, of which M were search calls". */
  meanNumTurns: number;
  /**
   * Mean tool calls per ok run, split by purpose (see runClaude.ts's
   * classifyToolCall) — how much of an arm's turn budget went on *finding*
   * things versus *doing* things, which a raw turn count can't distinguish.
   *
   * null when no ok run in the group recorded tool calls at all: every run
   * predating the harness's stream-json parsing has no such data, and a
   * historical cell must say "unknown" rather than claim a confident 0. When
   * only some runs in a group have it (a task re-run across the change), the
   * mean covers exactly those runs — averaging in the older ones as 0 would
   * understate the real figure.
   */
  meanSearchToolCalls: number | null;
  meanEditToolCalls: number | null;
  meanOtherToolCalls: number | null;
}

// Sums every token that actually moved through the context (input + output +
// both cache buckets), rather than excluding cacheReadTokens. A cache hit vs.
// miss on the system-prompt/tool-schema prefix depends on timing/locality
// relative to Anthropic's 1h ephemeral cache, not on anything the run itself
// did - counting only cacheCreationTokens made identical runs look wildly
// different in "tokens spent" depending on that unrelated luck (see
// docs/results/find-impl-token-increase-investigation.md).
export function tokensSpent(r: TokenEconomyRun): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens;
}

/**
 * Which arms actually appear in this run set, in ARM_ORDER.
 *
 * Every table/chart iterates this rather than a hardcoded arm list, so a
 * report built from 2-arm-only history renders exactly as it always did (no
 * empty "gmesh-trusted" rows or legend entries) while one that includes real
 * `gmesh-trusted` runs picks the third arm up automatically. Unknown arms
 * (a record written by a future harness) are appended alphabetically rather
 * than dropped.
 */
export function armsPresent(runs: TokenEconomyRun[]): Arm[] {
  const present = new Set<Arm>(runs.map((r) => r.arm));
  const known = ARM_ORDER.filter((arm) => present.has(arm));
  const unknown = [...present].filter((arm) => !ARM_ORDER.includes(arm)).sort();
  return [...known, ...unknown];
}

/**
 * Mean of one tool-call bucket over just the runs that recorded it, or null
 * when none did — see ArmAggregate's meanSearchToolCalls doc for why "unknown"
 * and "zero" must not collapse into the same number here.
 */
function meanRecordedToolCalls(runs: TokenEconomyRun[], pick: (r: TokenEconomyRun) => number | undefined): number | null {
  const values = runs.map(pick).filter((v): v is number => v !== undefined);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function aggregateGroup(taskId: string, arm: Arm, group: TokenEconomyRun[]): ArmAggregate | null {
  const ok = group.filter((r) => r.status === "ok");
  if (ok.length === 0) return null;

  const tokens = ok.map(tokensSpent);
  return {
    taskId,
    arm,
    total: group.length,
    okCount: ok.length,
    passCount: ok.filter((r) => r.oraclePassed).length,
    meanTokens: tokens.reduce((a, b) => a + b, 0) / tokens.length,
    bestTokens: Math.min(...tokens),
    worstTokens: Math.max(...tokens),
    meanCostUsd: ok.reduce((a, r) => a + r.costUsd, 0) / ok.length,
    meanDurationMs: ok.reduce((a, r) => a + r.durationMs, 0) / ok.length,
    meanNumTurns: ok.reduce((a, r) => a + r.numTurns, 0) / ok.length,
    meanSearchToolCalls: meanRecordedToolCalls(ok, (r) => r.searchToolCalls),
    meanEditToolCalls: meanRecordedToolCalls(ok, (r) => r.editToolCalls),
    meanOtherToolCalls: meanRecordedToolCalls(ok, (r) => r.otherToolCalls),
  };
}

export async function loadRuns<T>(resultsDir: string, experiment: string): Promise<T[]> {
  const dir = path.join(resultsDir, experiment);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const runs: T[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8");
    runs.push(...(JSON.parse(raw) as T[]));
  }
  return runs;
}

export interface PairedArmTotals {
  armA: Arm;
  armB: Arm;
  /** tokensSpent() summed over `pairCount` pairs only — never over `comparedPairs`. */
  totalA: number;
  totalB: number;
  /** numTurns summed over the same `pairCount` pairs, for turn-count comparisons. */
  turnsA: number;
  turnsB: number;
  /** Pairs where both arms ran ok AND both passed oracle — the token denominator. */
  pairCount: number;
  /** Pairs where both arms ran ok, oracle result ignored — the pass-rate denominator. */
  comparedPairs: number;
  /**
   * Pairs where both arms have a record but at least one didn't finish ok
   * (errored, or hit the per-run budget cap). Excluded from every number
   * above, and counted separately so a comparison built on very few pairs
   * can say *why* rather than just looking thin.
   */
  droppedPairs: number;
  passCountA: number;
  passCountB: number;
}

interface PairedRuns {
  /** One entry per (taskId, repetition) where both arms ran ok AND passed oracle — the token/breakdown denominator. */
  pairs: { a: TokenEconomyRun; b: TokenEconomyRun }[];
  /** Pairs where both arms ran ok, oracle result ignored — the pass-rate denominator. */
  comparedPairs: number;
  /** Pairs where both arms have a record but at least one didn't finish ok. */
  droppedPairs: number;
  passCountA: number;
  passCountB: number;
}

/**
 * Pairs two arms' runs by (taskId, repetition), keeping the actual matched
 * run objects rather than a pre-summed number — the one piece of pairing
 * logic every "paired X by Y" function in this file (token totals, per-
 * category token-type breakdown, and whatever's added next) needs identically
 * and must never re-derive slightly differently. pairedTotals below sums
 * tokensSpent() over `pairs`; computeCategoryTokenBreakdown sums the four raw
 * token fields over the same `pairs` instead.
 *
 * The two counts are deliberately different. `pairs` (and therefore any token
 * sum built from it) is restricted to both-passed-oracle, so a token "win"
 * can't be hiding behind the other arm's oracle false-negative (or vice
 * versa). `comparedPairs`/pass counts cover every pair where both arms merely
 * ran ok — restricting those to both-passed pairs would make them trivially
 * 100%/100% and answer nothing.
 */
function pairedRuns(runs: TokenEconomyRun[], armA: Arm, armB: Arm): PairedRuns {
  // Only ok runs enter the pairing map. That matters beyond the obvious: a
  // (taskId, repetition) key recurs across result files, so "last one wins" —
  // and letting a later non-ok record displace an earlier ok one would silently
  // shrink pairedTokenTotals()'s long-standing numbers. droppedPairs is
  // therefore derived from a separate presence-only pass below.
  const byTaskRep = new Map<string, { a?: TokenEconomyRun; b?: TokenEconomyRun }>();
  const armsSeenByTaskRep = new Map<string, Set<Arm>>();
  for (const r of runs) {
    if (r.arm !== armA && r.arm !== armB) continue;
    const key = `${r.taskId}::${r.repetition}`;
    const seen = armsSeenByTaskRep.get(key) ?? new Set<Arm>();
    seen.add(r.arm);
    armsSeenByTaskRep.set(key, seen);

    if (r.status !== "ok") continue;
    const pair = byTaskRep.get(key) ?? {};
    if (r.arm === armA) pair.a = r;
    else pair.b = r;
    byTaskRep.set(key, pair);
  }

  const pairs: { a: TokenEconomyRun; b: TokenEconomyRun }[] = [];
  let comparedPairs = 0;
  let passCountA = 0;
  let passCountB = 0;
  for (const { a, b } of byTaskRep.values()) {
    if (!a || !b) continue;
    comparedPairs++;
    if (a.oraclePassed) passCountA++;
    if (b.oraclePassed) passCountB++;
    if (!a.oraclePassed || !b.oraclePassed) continue;
    pairs.push({ a, b });
  }
  // Every (taskId, rep) where both arms were attempted, minus the ones that
  // yielded a usable ok/ok pair — i.e. those lost to an error or a budget cap.
  const bothAttempted = [...armsSeenByTaskRep.values()].filter((seen) => seen.has(armA) && seen.has(armB)).length;
  const droppedPairs = bothAttempted - comparedPairs;

  return { pairs, comparedPairs, droppedPairs, passCountA, passCountB };
}

/**
 * Pairs two arms' runs by (taskId, repetition) and reports both a token
 * comparison and an oracle comparison over that same set of pairs. Thin
 * wrapper around pairedRuns() that sums tokensSpent()/numTurns over its
 * `pairs` — see pairedRuns' doc comment for why the pairing itself lives
 * there and not here.
 */
function pairedTotals(runs: TokenEconomyRun[], armA: Arm, armB: Arm): PairedArmTotals {
  const { pairs, comparedPairs, droppedPairs, passCountA, passCountB } = pairedRuns(runs, armA, armB);

  let totalA = 0;
  let totalB = 0;
  let turnsA = 0;
  let turnsB = 0;
  for (const { a, b } of pairs) {
    totalA += tokensSpent(a);
    totalB += tokensSpent(b);
    turnsA += a.numTurns;
    turnsB += b.numTurns;
  }

  return { armA, armB, totalA, totalB, turnsA, turnsB, pairCount: pairs.length, comparedPairs, droppedPairs, passCountA, passCountB };
}

/**
 * General paired comparison between any two arms — the gmesh-vs-gmesh-trusted
 * question (does the agent's habit of manually re-verifying g-mesh's results
 * cost tokens for nothing, or does it catch real g-mesh mistakes?) needs the
 * same pairing logic pairedTokenTotals has always used, just not hardwired to
 * gmesh/baseline.
 */
export function pairedArmsTokenTotals(runs: TokenEconomyRun[], armA: Arm, armB: Arm): PairedArmTotals {
  return pairedTotals(runs, armA, armB);
}

/**
 * Sum of tokensSpent() for every (taskId, repetition) pair where *both* arms
 * ran ok and passed oracle — the token comparison restricted to runs neither
 * arm's own answer quality calls into question, so a token "win" can't be
 * hiding behind the other arm's oracle false-negative (or vice versa).
 *
 * Kept as its own gmesh/baseline-named function (rather than folded into
 * pairedArmsTokenTotals) because it is the headline number the existing
 * findings docs and report sections are written against; only its internals
 * are now shared. Runs from any third arm are ignored here, so the number is
 * unchanged by the existence of `gmesh-trusted`.
 */
export function pairedTokenTotals(runs: TokenEconomyRun[]): { totalGmesh: number; totalBaseline: number; pairCount: number } {
  const { totalA, totalB, pairCount } = pairedTotals(runs, "gmesh", "baseline");
  return { totalGmesh: totalA, totalBaseline: totalB, pairCount };
}

/**
 * Splits historical runs into those graded against the task definition as it
 * exists today ("current") and everything else ("stale") — a run with no
 * `taskDefHash` (recorded before that field existed), a hash that doesn't
 * match the task's current definition (the prompt/oracle was edited since),
 * or a `taskId` no longer present in the registry at all (task
 * removed/renamed). See docs/results/v0.2.0-realistic-tasks-findings.md,
 * "Stale run-record contamination in the cumulative report" for the bug this
 * exists to fix — report.ts aggregated pre-edit and post-edit runs together
 * under the same task id with no way to tell them apart.
 */
export function partitionByCurrentDef(
  runs: TokenEconomyRun[],
  currentHashByTaskId: Map<string, string>,
): { current: TokenEconomyRun[]; stale: TokenEconomyRun[] } {
  const current: TokenEconomyRun[] = [];
  const stale: TokenEconomyRun[] = [];
  for (const run of runs) {
    const currentHash = currentHashByTaskId.get(run.taskId);
    if (run.taskDefHash && currentHash !== undefined && run.taskDefHash === currentHash) {
      current.push(run);
    } else {
      stale.push(run);
    }
  }
  return { current, stale };
}

/** Stale-run counts grouped by taskId, sorted by taskId ascending — the "Excluded as stale" report section's data source. */
export function computeStaleSummary(stale: TokenEconomyRun[]): { taskId: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const run of stale) {
    counts.set(run.taskId, (counts.get(run.taskId) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([taskId, count]) => ({ taskId, count }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export const UNCATEGORIZED = "uncategorized (pre-v2)";

export interface CorrectnessRow {
  category: string;
  arm: Arm;
  passed: number;
  total: number;
}

/**
 * Correctness by arm by category — a task's category/expectedWinner is
 * task-authoring metadata, absent on pre-v2 runs, so those fall into an
 * explicit "uncategorized" bucket rather than being silently dropped or
 * miscounted. Mirrors report.ts's old reportCorrectness() grouping/order.
 */
export function computeCorrectnessTable(runs: TokenEconomyRun[]): CorrectnessRow[] {
  const byCategoryArm = new Map<string, { passed: number; total: number }>();
  for (const r of runs) {
    if (r.status !== "ok") continue;
    const key = `${r.category ?? UNCATEGORIZED}::${r.arm}`;
    const tally = byCategoryArm.get(key) ?? { passed: 0, total: 0 };
    tally.total++;
    if (r.oraclePassed) tally.passed++;
    byCategoryArm.set(key, tally);
  }

  const categories = [...new Set(runs.map((r) => r.category ?? UNCATEGORIZED))].sort();
  const arms = armsPresent(runs);

  const rows: CorrectnessRow[] = [];
  for (const category of categories) {
    for (const arm of arms) {
      const tally = byCategoryArm.get(`${category}::${arm}`);
      if (!tally) continue;
      rows.push({ category, arm, passed: tally.passed, total: tally.total });
    }
  }
  return rows;
}

export interface CategoryTokenRow {
  category: string;
  gmeshMeanTokens: number;
  baselineMeanTokens: number;
  savingsPct: number;
  pairCount: number;
}

/**
 * Paired gmesh-vs-baseline token savings by category — same pairing
 * discipline as pairedTokenTotals/pairedArmsTokenTotals (only (taskId,
 * repetition) pairs where both arms ran ok AND passed oracle, summed then
 * divided by pairCount), just scoped to one category's runs at a time instead
 * of summed across every task. Exists because the blended, all-tasks savings
 * % (computeAggregate/pairedTokenTotals) hides categories like "multihop"
 * where g-mesh's turn-count advantage is largest, diluted by easier
 * categories where a fixed per-turn MCP tool-schema cost can outweigh it. A
 * category with zero qualifying pairs is omitted rather than emitted as 0%.
 */
export function computeCategoryTokenTable(runs: TokenEconomyRun[]): CategoryTokenRow[] {
  const categories = [...new Set(runs.map((r) => r.category ?? UNCATEGORIZED))].sort();

  const rows: CategoryTokenRow[] = [];
  for (const category of categories) {
    const categoryRuns = runs.filter((r) => (r.category ?? UNCATEGORIZED) === category);
    const paired = pairedArmsTokenTotals(categoryRuns, "gmesh", "baseline");
    if (paired.pairCount === 0) continue;
    rows.push({
      category,
      gmeshMeanTokens: paired.totalA / paired.pairCount,
      baselineMeanTokens: paired.totalB / paired.pairCount,
      savingsPct: paired.totalB > 0 ? ((paired.totalB - paired.totalA) / paired.totalB) * 100 : 0,
      pairCount: paired.pairCount,
    });
  }
  return rows;
}

export interface CategoryTokenBreakdownRow {
  category: string;
  arm: Arm;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCacheCreationTokens: number;
  meanCacheReadTokens: number;
  pairCount: number;
}

/**
 * Same category x gmesh/baseline pairing as computeCategoryTokenTable, but
 * broken into the four token fields tokensSpent() sums together instead of
 * the summed total. The sum hides real mechanism: on "lookup", gmesh pays
 * more in BOTH cacheCreate and cacheRead (a fixed schema tax with nothing
 * offsetting it); on "multi-hop"/"ambiguous-name", baseline pays dramatically
 * more in cacheCreate (each grep/Read round-trip adds fresh, never-cached
 * content) AND more cacheRead (a longer transcript from more turns) — a
 * compounding double cost that a single "tokens" number can't distinguish
 * from a one-sided difference. `input` is included for completeness but is
 * noise everywhere (5-15 tokens) since prompt caching absorbs almost
 * everything into the other two buckets.
 *
 * Reuses pairedRuns rather than re-deriving the pairing: two rows per
 * qualifying category (one per arm), each row's means computed over the same
 * `pairs` pairedTotals would sum tokensSpent() over — so this table's numbers
 * always agree with computeCategoryTokenTable's for the same category (their
 * per-field sum equals the total column there), just split by field. A
 * category with zero qualifying pairs is omitted, same as
 * computeCategoryTokenTable.
 */
export function computeCategoryTokenBreakdown(runs: TokenEconomyRun[]): CategoryTokenBreakdownRow[] {
  const categories = [...new Set(runs.map((r) => r.category ?? UNCATEGORIZED))].sort();
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

  const rows: CategoryTokenBreakdownRow[] = [];
  for (const category of categories) {
    const categoryRuns = runs.filter((r) => (r.category ?? UNCATEGORIZED) === category);
    const { pairs } = pairedRuns(categoryRuns, "gmesh", "baseline");
    if (pairs.length === 0) continue;

    const gmeshRuns = pairs.map((p) => p.a);
    const baselineRuns = pairs.map((p) => p.b);
    rows.push({
      category,
      arm: "gmesh",
      meanInputTokens: mean(gmeshRuns.map((r) => r.inputTokens)),
      meanOutputTokens: mean(gmeshRuns.map((r) => r.outputTokens)),
      meanCacheCreationTokens: mean(gmeshRuns.map((r) => r.cacheCreationTokens)),
      meanCacheReadTokens: mean(gmeshRuns.map((r) => r.cacheReadTokens)),
      pairCount: pairs.length,
    });
    rows.push({
      category,
      arm: "baseline",
      meanInputTokens: mean(baselineRuns.map((r) => r.inputTokens)),
      meanOutputTokens: mean(baselineRuns.map((r) => r.outputTokens)),
      meanCacheCreationTokens: mean(baselineRuns.map((r) => r.cacheCreationTokens)),
      meanCacheReadTokens: mean(baselineRuns.map((r) => r.cacheReadTokens)),
      pairCount: pairs.length,
    });
  }
  return rows;
}

/**
 * "8.0 (6.0 search, 2.0 edit)" — an arm's mean turns for one task, split by
 * what those turns were spent on. Shared by both report surfaces (the HTML
 * task table and report.ts's markdown one) so they can't drift apart on a
 * number readers compare across them.
 *
 * Falls back to the bare turn count for runs recorded before the harness could
 * see tool names (see ArmAggregate's meanSearchToolCalls), rather than a "0
 * search" that would read as a measurement instead of a gap. The `other`
 * bucket is shown only when non-zero: it should stay empty (no arm is granted
 * tools outside the search/edit sets), so a visible one is a finding.
 */
export function formatTurnsWithToolCalls(agg: ArmAggregate): string {
  const turns = agg.meanNumTurns.toFixed(1);
  if (agg.meanSearchToolCalls === null && agg.meanEditToolCalls === null) return turns;
  const parts = [
    `${(agg.meanSearchToolCalls ?? 0).toFixed(1)} search`,
    `${(agg.meanEditToolCalls ?? 0).toFixed(1)} edit`,
  ];
  if ((agg.meanOtherToolCalls ?? 0) > 0) parts.push(`${(agg.meanOtherToolCalls ?? 0).toFixed(1)} other`);
  return `${turns} (${parts.join(", ")})`;
}

/** Mean wall-clock duration, in seconds, one decimal place — shared by report.ts's markdown table and htmlReport.ts's HTML one so they can't drift apart on the unit. */
export function formatDurationSeconds(agg: ArmAggregate): string {
  return `${(agg.meanDurationMs / 1000).toFixed(1)}s`;
}

export interface TaskArmCell {
  arm: Arm;
  /**
   * null when no run of this arm for this task finished ok (see groupLength to
   * tell "none attempted" from "all failed"). Carries the per-cell means the
   * task table renders — tokens, cost, turns, and the search/edit tool-call
   * split — so this stays one aggregate rather than a growing set of parallel
   * fields that could disagree about which runs they averaged.
   */
  agg: ArmAggregate | null;
  groupLength: number;
}

export interface TaskRow {
  taskId: string;
  expectedWinner: string;
  /** One cell per arm present anywhere in the run set, in ARM_ORDER — the single place consumers learn which arms to render. */
  cells: TaskArmCell[];
}

/** Convenience lookup for the callers that genuinely need one specific arm (e.g. the gmesh-vs-baseline aggregate). */
export function taskRowCell(row: TaskRow, arm: Arm): TaskArmCell | undefined {
  return row.cells.find((c) => c.arm === arm);
}

/** Per-taskId aggregates for every arm present, in first-seen task order (mirrors report.ts's old iteration order). */
export function computeTaskTable(runs: TokenEconomyRun[]): TaskRow[] {
  const byTaskArm = new Map<string, TokenEconomyRun[]>();
  const expectedWinnerByTask = new Map<string, string>();
  for (const r of runs) {
    const key = `${r.taskId}::${r.arm}`;
    if (!byTaskArm.has(key)) byTaskArm.set(key, []);
    byTaskArm.get(key)!.push(r);
    if (r.expectedWinner && !expectedWinnerByTask.has(r.taskId)) {
      expectedWinnerByTask.set(r.taskId, r.expectedWinner);
    }
  }

  const taskIds = [...new Set(runs.map((r) => r.taskId))];
  const arms = armsPresent(runs);

  return taskIds.map((taskId) => ({
    taskId,
    expectedWinner: expectedWinnerByTask.get(taskId) ?? "-",
    cells: arms.map((arm) => {
      const group = byTaskArm.get(`${taskId}::${arm}`) ?? [];
      return { arm, agg: aggregateGroup(taskId, arm, group), groupLength: group.length };
    }),
  }));
}

export interface Aggregate {
  taskCount: number;
  totalGmeshTokens: number;
  totalBaselineTokens: number;
  unconditionalReductionPct: number;
  gmeshOracleOk: number;
  gmeshOracleTotal: number;
  baselineOracleOk: number;
  baselineOracleTotal: number;
}

export function computeAggregate(runs: TokenEconomyRun[]): Aggregate {
  const taskTable = computeTaskTable(runs);

  let taskCount = 0;
  let totalGmeshTokens = 0;
  let totalBaselineTokens = 0;
  let gmeshOracleOk = 0;
  let gmeshOracleTotal = 0;
  let baselineOracleOk = 0;
  let baselineOracleTotal = 0;

  // Deliberately gmesh-vs-baseline only: this is the headline comparison the
  // findings docs are written against, and folding a third arm into these
  // totals would silently change what "unconditional reduction" means.
  for (const row of taskTable) {
    const gmesh = taskRowCell(row, "gmesh")?.agg;
    const baseline = taskRowCell(row, "baseline")?.agg;
    if (gmesh && baseline) {
      taskCount++;
      totalGmeshTokens += gmesh.meanTokens;
      totalBaselineTokens += baseline.meanTokens;
      gmeshOracleOk += gmesh.passCount;
      gmeshOracleTotal += gmesh.okCount;
      baselineOracleOk += baseline.passCount;
      baselineOracleTotal += baseline.okCount;
    }
  }

  const unconditionalReductionPct =
    totalBaselineTokens > 0 ? ((totalBaselineTokens - totalGmeshTokens) / totalBaselineTokens) * 100 : 0;

  return {
    taskCount,
    totalGmeshTokens,
    totalBaselineTokens,
    unconditionalReductionPct,
    gmeshOracleOk,
    gmeshOracleTotal,
    baselineOracleOk,
    baselineOracleTotal,
  };
}

/** Per-task paired mean tokens (gmesh vs baseline), restricted to oraclePassed:true pairs for that task only. */
function perTaskPairedMeans(runs: TokenEconomyRun[], taskId: string): { gmeshMean: number; baselineMean: number; pairCount: number } | null {
  const taskRuns = runs.filter(
    (r) => r.taskId === taskId && r.status === "ok" && (r.arm === "gmesh" || r.arm === "baseline"),
  );
  const byRep = new Map<number, { gmesh?: TokenEconomyRun; baseline?: TokenEconomyRun }>();
  for (const r of taskRuns) {
    const pair = byRep.get(r.repetition) ?? {};
    pair[r.arm as "gmesh" | "baseline"] = r;
    byRep.set(r.repetition, pair);
  }

  let gmeshTotal = 0;
  let baselineTotal = 0;
  let pairCount = 0;
  for (const { gmesh, baseline } of byRep.values()) {
    if (!gmesh || !baseline) continue;
    if (!gmesh.oraclePassed || !baseline.oraclePassed) continue;
    gmeshTotal += tokensSpent(gmesh);
    baselineTotal += tokensSpent(baseline);
    pairCount++;
  }
  if (pairCount === 0) return null;
  return { gmeshMean: gmeshTotal / pairCount, baselineMean: baselineTotal / pairCount, pairCount };
}

/**
 * Deterministic, rule-based analysis bullets — no LLM involved. Skips any
 * check that would be nonsensical on sparse/empty input rather than
 * crashing or emitting a bullet with no basis.
 */
export function computeAnalysis(
  runs: TokenEconomyRun[],
  correctnessTable: CorrectnessRow[],
  taskTable: TaskRow[],
  aggregate: Aggregate,
  paired: { totalGmesh: number; totalBaseline: number; pairCount: number },
): string[] {
  const bullets: string[] = [];

  const pairedReductionPct = paired.totalBaseline > 0 ? ((paired.totalBaseline - paired.totalGmesh) / paired.totalBaseline) * 100 : null;

  if (pairedReductionPct !== null && Math.abs(pairedReductionPct - aggregate.unconditionalReductionPct) > 15) {
    bullets.push(
      `The unconditional token reduction (${aggregate.unconditionalReductionPct.toFixed(1)}%) and the paired, ` +
        `oracle-restricted reduction (${pairedReductionPct.toFixed(1)}%, n=${paired.pairCount}) diverge by ` +
        `more than 15 points — likely an oracle-driven confound (one arm's failing runs are skewing the ` +
        `unconditional number). Trust the paired figure over the unconditional one.`,
    );
  }

  // gmesh-vs-baseline divergence only — the gmesh-trusted comparison gets its
  // own dedicated bullet below rather than being mixed into this one.
  const byCategory = new Map<string, { gmesh?: CorrectnessRow; baseline?: CorrectnessRow }>();
  for (const row of correctnessTable) {
    if (row.arm !== "gmesh" && row.arm !== "baseline") continue;
    const entry = byCategory.get(row.category) ?? {};
    entry[row.arm] = row;
    byCategory.set(row.category, entry);
  }
  for (const [category, { gmesh, baseline }] of byCategory) {
    if (!gmesh || !baseline) continue;
    const gmeshPct = (gmesh.passed / gmesh.total) * 100;
    const baselinePct = (baseline.passed / baseline.total) * 100;
    if (Math.abs(gmeshPct - baselinePct) >= 20) {
      const winner = gmeshPct > baselinePct ? "gmesh" : "baseline";
      bullets.push(
        `Category "${category}": oracle pass rates diverge by ${Math.abs(gmeshPct - baselinePct).toFixed(0)} points ` +
          `(gmesh ${gmesh.passed}/${gmesh.total}, baseline ${baseline.passed}/${baseline.total}) — ${winner} passes ` +
          `substantially more often.`,
      );
    }
  }

  const winnerTasks = taskTable.filter((t) => t.expectedWinner === "gmesh" || t.expectedWinner === "baseline");
  if (winnerTasks.length > 0) {
    let matches = 0;
    const mismatches: string[] = [];
    for (const t of winnerTasks) {
      const means = perTaskPairedMeans(runs, t.taskId);
      if (!means) continue;
      const observedWinner = means.gmeshMean < means.baselineMean ? "gmesh" : "baseline";
      if (observedWinner === t.expectedWinner) {
        matches++;
      } else {
        mismatches.push(t.taskId);
      }
    }
    const evaluated = matches + mismatches.length;
    if (evaluated > 0) {
      bullets.push(
        `Expected-winner check: ${matches}/${evaluated} tasks with a declared expected winner matched the ` +
          `observed lower-token arm` + (mismatches.length > 0 ? `; mismatches: ${mismatches.join(", ")}.` : "."),
      );
    }
  }

  const parityTasks = taskTable.filter((t) => t.expectedWinner === "parity");
  for (const t of parityTasks) {
    const means = perTaskPairedMeans(runs, t.taskId);
    if (!means || means.baselineMean === 0) continue;
    const gap = Math.abs(means.gmeshMean - means.baselineMean) / means.baselineMean;
    if (gap > 0.25) {
      bullets.push(
        `Task "${t.taskId}" is declared expectedWinner:"parity" but its arms' mean tokens differ by ` +
          `${(gap * 100).toFixed(0)}% (gmesh ${means.gmeshMean.toFixed(0)}, baseline ${means.baselineMean.toFixed(0)}) — ` +
          `an unexpected asymmetry worth a second look.`,
      );
    }
  }

  // The self-verification experiment: the gmesh arm habitually re-checks
  // g-mesh's structural results with grep/Read before answering (see
  // docs/results/v0.2.0-realistic-tasks-findings.md, "Turn-count evidence for
  // the multi-hop self-verification pattern"). gmesh-trusted is the same arm
  // told not to. Comparing them answers whether that habit is free paranoia or
  // is catching real g-mesh mistakes. Emitted only when gmesh-trusted runs
  // actually pair up with gmesh runs — a 2-arm report is unchanged.
  const trusted = pairedArmsTokenTotals(runs, "gmesh", "gmesh-trusted");
  const trustedPrefix =
    `Self-verification cost (gmesh-trusted vs gmesh — identical tools and MCP config, only the ` +
    `"don't re-verify g-mesh" instruction differs)`;
  const droppedNote =
    trusted.droppedPairs > 0
      ? ` ${trusted.droppedPairs} further pair(s) excluded because one arm did not finish ok — an error, or the per-run budget cap.`
      : "";

  if (trusted.comparedPairs > 0) {
    const gmeshPassPct = (trusted.passCountA / trusted.comparedPairs) * 100;
    const trustedPassPct = (trusted.passCountB / trusted.comparedPairs) * 100;
    const verdict =
      trusted.passCountB > trusted.passCountA
        ? `accuracy did not suffer (gmesh-trusted actually passed ${trusted.passCountB - trusted.passCountA} more)`
        : trusted.passCountB === trusted.passCountA
          ? "accuracy held exactly, so whatever the natural gmesh arm spent on re-verifying was overhead the oracle never rewarded"
          : `accuracy DROPPED by ${trusted.passCountA - trusted.passCountB} pair(s), so the manual re-verification is catching real g-mesh mistakes rather than just being paranoid`;

    const tokenPart =
      trusted.pairCount > 0 && trusted.totalA > 0
        ? (() => {
            const deltaPct = ((trusted.totalA - trusted.totalB) / trusted.totalA) * 100;
            const direction = deltaPct >= 0 ? `${deltaPct.toFixed(1)}% fewer` : `${Math.abs(deltaPct).toFixed(1)}% more`;
            return (
              `over the ${trusted.pairCount} pair(s) where both passed oracle it used ${direction} tokens ` +
              `(${trusted.totalB.toFixed(0)} vs ${trusted.totalA.toFixed(0)}) and ${trusted.turnsB} vs ${trusted.turnsA} turns; `
            );
          })()
        : "no (task, rep) pair had both arms pass oracle, so no token comparison is possible; ";

    bullets.push(
      `${trustedPrefix}: ${tokenPart}oracle pass rate across the ${trusted.comparedPairs} pair(s) where both ` +
        `arms ran — gmesh ${trusted.passCountA}/${trusted.comparedPairs} (${gmeshPassPct.toFixed(0)}%), ` +
        `gmesh-trusted ${trusted.passCountB}/${trusted.comparedPairs} (${trustedPassPct.toFixed(0)}%) — ${verdict}.` +
        droppedNote,
    );
  } else if (trusted.droppedPairs > 0) {
    // gmesh-trusted ran, but never alongside a gmesh run that finished — worth
    // saying out loud instead of silently omitting the comparison, since "the
    // natural gmesh arm blew its budget on this task" is itself a result.
    bullets.push(
      `${trustedPrefix}: no comparison possible yet — all ${trusted.droppedPairs} attempted pair(s) were lost ` +
        `because one arm did not finish ok (an error, or the per-run budget cap). A gmesh arm that cannot complete ` +
        `the task inside its budget while gmesh-trusted can is itself worth noting.`,
    );
  }

  const overallGmeshPct = aggregate.gmeshOracleTotal > 0 ? (aggregate.gmeshOracleOk / aggregate.gmeshOracleTotal) * 100 : null;
  const overallBaselinePct = aggregate.baselineOracleTotal > 0 ? (aggregate.baselineOracleOk / aggregate.baselineOracleTotal) * 100 : null;
  bullets.push(
    `Bottom line: across ${aggregate.taskCount} compared tasks, gmesh used ${aggregate.unconditionalReductionPct.toFixed(1)}% ` +
      `fewer tokens (unconditional)` +
      (pairedReductionPct !== null ? `, ${pairedReductionPct.toFixed(1)}% fewer paired (n=${paired.pairCount})` : "") +
      `. Oracle pass rate — gmesh: ${aggregate.gmeshOracleOk}/${aggregate.gmeshOracleTotal}` +
      (overallGmeshPct !== null ? ` (${overallGmeshPct.toFixed(0)}%)` : "") +
      `, baseline: ${aggregate.baselineOracleOk}/${aggregate.baselineOracleTotal}` +
      (overallBaselinePct !== null ? ` (${overallBaselinePct.toFixed(0)}%)` : "") +
      `.`,
  );

  return bullets;
}
