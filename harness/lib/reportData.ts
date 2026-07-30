import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { TokenEconomyRun } from "../token-economy.js";

export interface ArmAggregate {
  taskId: string;
  arm: "gmesh" | "baseline";
  total: number;
  okCount: number;
  passCount: number;
  meanTokens: number;
  bestTokens: number;
  worstTokens: number;
  meanCostUsd: number;
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

export function aggregateGroup(taskId: string, arm: "gmesh" | "baseline", group: TokenEconomyRun[]): ArmAggregate | null {
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

/**
 * Sum of tokensSpent() for every (taskId, repetition) pair where *both* arms
 * ran ok and passed oracle — the token comparison restricted to runs neither
 * arm's own answer quality calls into question, so a token "win" can't be
 * hiding behind the other arm's oracle false-negative (or vice versa).
 */
export function pairedTokenTotals(runs: TokenEconomyRun[]): { totalGmesh: number; totalBaseline: number; pairCount: number } {
  const byTaskRep = new Map<string, { gmesh?: TokenEconomyRun; baseline?: TokenEconomyRun }>();
  for (const r of runs) {
    if (r.status !== "ok") continue;
    const key = `${r.taskId}::${r.repetition}`;
    const pair = byTaskRep.get(key) ?? {};
    pair[r.arm] = r;
    byTaskRep.set(key, pair);
  }

  let totalGmesh = 0;
  let totalBaseline = 0;
  let pairCount = 0;
  for (const { gmesh, baseline } of byTaskRep.values()) {
    if (!gmesh || !baseline) continue;
    if (!gmesh.oraclePassed || !baseline.oraclePassed) continue;
    totalGmesh += tokensSpent(gmesh);
    totalBaseline += tokensSpent(baseline);
    pairCount++;
  }
  return { totalGmesh, totalBaseline, pairCount };
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
  arm: "gmesh" | "baseline";
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

  const rows: CorrectnessRow[] = [];
  for (const category of categories) {
    for (const arm of ["gmesh", "baseline"] as const) {
      const tally = byCategoryArm.get(`${category}::${arm}`);
      if (!tally) continue;
      rows.push({ category, arm, passed: tally.passed, total: tally.total });
    }
  }
  return rows;
}

export interface TaskRow {
  taskId: string;
  expectedWinner: string;
  gmesh: ArmAggregate | null;
  gmeshGroupLength: number;
  baseline: ArmAggregate | null;
  baselineGroupLength: number;
}

/** Per-taskId aggregates for both arms, in first-seen task order (mirrors report.ts's old iteration order). */
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

  return taskIds.map((taskId) => {
    const gmeshGroup = byTaskArm.get(`${taskId}::gmesh`) ?? [];
    const baselineGroup = byTaskArm.get(`${taskId}::baseline`) ?? [];
    return {
      taskId,
      expectedWinner: expectedWinnerByTask.get(taskId) ?? "-",
      gmesh: aggregateGroup(taskId, "gmesh", gmeshGroup),
      gmeshGroupLength: gmeshGroup.length,
      baseline: aggregateGroup(taskId, "baseline", baselineGroup),
      baselineGroupLength: baselineGroup.length,
    };
  });
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

  for (const row of taskTable) {
    if (row.gmesh && row.baseline) {
      taskCount++;
      totalGmeshTokens += row.gmesh.meanTokens;
      totalBaselineTokens += row.baseline.meanTokens;
      gmeshOracleOk += row.gmesh.passCount;
      gmeshOracleTotal += row.gmesh.okCount;
      baselineOracleOk += row.baseline.passCount;
      baselineOracleTotal += row.baseline.okCount;
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
  const taskRuns = runs.filter((r) => r.taskId === taskId && r.status === "ok");
  const byRep = new Map<number, { gmesh?: TokenEconomyRun; baseline?: TokenEconomyRun }>();
  for (const r of taskRuns) {
    const pair = byRep.get(r.repetition) ?? {};
    pair[r.arm] = r;
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

  const byCategory = new Map<string, { gmesh?: CorrectnessRow; baseline?: CorrectnessRow }>();
  for (const row of correctnessTable) {
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
