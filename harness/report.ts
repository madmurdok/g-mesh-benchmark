import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface TokenEconomyRun {
  taskId: string;
  corpusId: string;
  arm: "gmesh" | "baseline";
  repetition: number;
  /** Absent on pre-v2 task records, which predate category/expectedWinner. */
  category?: string;
  expectedWinner?: "gmesh" | "baseline" | "parity";
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  costUsd: number;
  /** Grading-call spend, judge mode only; absent on runs predating judge mode. Never added into costUsd/tokensSpent. */
  judgeCostUsd?: number;
  oraclePassed: boolean;
  status: string;
}

interface ArmAggregate {
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

function aggregateGroup(taskId: string, arm: "gmesh" | "baseline", group: TokenEconomyRun[]): ArmAggregate | null {
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

async function loadRuns<T>(experiment: string): Promise<T[]> {
  const dir = path.join(ROOT, "results", experiment);
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const runs: T[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(dir, file), "utf8");
    runs.push(...(JSON.parse(raw) as T[]));
  }
  return runs;
}

// Sums every token that actually moved through the context (input + output +
// both cache buckets), rather than excluding cacheReadTokens. A cache hit vs.
// miss on the system-prompt/tool-schema prefix depends on timing/locality
// relative to Anthropic's 1h ephemeral cache, not on anything the run itself
// did - counting only cacheCreationTokens made identical runs look wildly
// different in "tokens spent" depending on that unrelated luck (see
// docs/results/find-impl-token-increase-investigation.md).
function tokensSpent(r: TokenEconomyRun): number {
  return r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens;
}

const UNCATEGORIZED = "uncategorized (pre-v2)";

interface CategoryTally {
  passed: number;
  total: number;
}

/**
 * Correctness by arm by category, printed *before* the token table — a task's
 * category/expectedWinner is task-authoring metadata, absent on pre-v2 runs,
 * so those fall into an explicit "uncategorized" bucket rather than being
 * silently dropped or miscounted.
 */
function reportCorrectness(runs: TokenEconomyRun[]): void {
  const byCategoryArm = new Map<string, CategoryTally>();
  for (const r of runs) {
    if (r.status !== "ok") continue;
    const key = `${r.category ?? UNCATEGORIZED}::${r.arm}`;
    const tally = byCategoryArm.get(key) ?? { passed: 0, total: 0 };
    tally.total++;
    if (r.oraclePassed) tally.passed++;
    byCategoryArm.set(key, tally);
  }

  const categories = [...new Set(runs.map((r) => r.category ?? UNCATEGORIZED))].sort();

  console.log("# Correctness report (by category)\n");
  console.log("| Category | Arm | Oracle pass rate |");
  console.log("|---|---|---|");
  for (const category of categories) {
    for (const arm of ["gmesh", "baseline"] as const) {
      const tally = byCategoryArm.get(`${category}::${arm}`);
      if (!tally) continue;
      console.log(`| ${category} | ${arm} | ${tally.passed}/${tally.total} |`);
    }
  }
  console.log("");
}

/**
 * Sum of tokensSpent() for every (taskId, repetition) pair where *both* arms
 * ran ok and passed oracle — the token comparison restricted to runs neither
 * arm's own answer quality calls into question, so a token "win" can't be
 * hiding behind the other arm's oracle false-negative (or vice versa).
 */
function pairedTokenTotals(runs: TokenEconomyRun[]): { totalGmesh: number; totalBaseline: number; pairCount: number } {
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

async function reportTokenEconomy(): Promise<void> {
  const runs = await loadRuns<TokenEconomyRun>("token-economy");

  reportCorrectness(runs);

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

  console.log("# Token economy report\n");
  console.log("| Task | Expected winner | Arm | Reps (ok/total) | Tokens mean | Tokens best | Tokens worst | Cost USD (mean) | Oracle (pass/ok) |");
  console.log("|---|---|---|---|---|---|---|---|---|");

  let totalGmesh = 0;
  let totalBaseline = 0;
  let gmeshOracleOk = 0;
  let gmeshOracleTotal = 0;
  let baselineOracleOk = 0;
  let baselineOracleTotal = 0;
  let taskCount = 0;

  for (const taskId of taskIds) {
    const gmeshGroup = byTaskArm.get(`${taskId}::gmesh`) ?? [];
    const baselineGroup = byTaskArm.get(`${taskId}::baseline`) ?? [];
    const gmesh = aggregateGroup(taskId, "gmesh", gmeshGroup);
    const baseline = aggregateGroup(taskId, "baseline", baselineGroup);
    const expectedWinner = expectedWinnerByTask.get(taskId) ?? "-";

    for (const [arm, group, agg] of [
      ["gmesh", gmeshGroup, gmesh] as const,
      ["baseline", baselineGroup, baseline] as const,
    ]) {
      if (!agg) {
        if (group.length > 0) {
          console.log(`| ${taskId} | ${expectedWinner} | ${arm} | 0/${group.length} | - | - | - | - | - |`);
        }
        continue;
      }
      console.log(
        `| ${taskId} | ${expectedWinner} | ${agg.arm} | ${agg.okCount}/${agg.total} | ${agg.meanTokens.toFixed(0)} | ${agg.bestTokens} | ${agg.worstTokens} | ${agg.meanCostUsd.toFixed(4)} | ${agg.passCount}/${agg.okCount} |`,
      );
    }

    if (gmesh && baseline) {
      taskCount++;
      totalGmesh += gmesh.meanTokens;
      totalBaseline += baseline.meanTokens;
      gmeshOracleOk += gmesh.passCount;
      gmeshOracleTotal += gmesh.okCount;
      baselineOracleOk += baseline.passCount;
      baselineOracleTotal += baseline.okCount;
    }
  }

  console.log("\n## Aggregate\n");
  console.log(`- Tasks compared: ${taskCount}`);
  console.log(`- Total mean tokens — gmesh: ${totalGmesh.toFixed(0)}, baseline: ${totalBaseline.toFixed(0)}`);
  const reduction = totalBaseline > 0 ? ((totalBaseline - totalGmesh) / totalBaseline) * 100 : 0;
  console.log(`- Token reduction, UNCONDITIONAL (gmesh vs baseline, every ok run regardless of oracle result): ${reduction.toFixed(1)}%`);
  console.log(`- Oracle pass rate — gmesh: ${gmeshOracleOk}/${gmeshOracleTotal}, baseline: ${baselineOracleOk}/${baselineOracleTotal}`);

  const paired = pairedTokenTotals(runs);
  const pairedReduction =
    paired.totalBaseline > 0 ? ((paired.totalBaseline - paired.totalGmesh) / paired.totalBaseline) * 100 : 0;
  console.log(
    `- Token reduction, PAIRED (only task/rep pairs where both arms had oraclePassed:true, n=${paired.pairCount} pairs): ${paired.pairCount > 0 ? pairedReduction.toFixed(1) + "%" : "n/a — no pairs where both arms passed oracle"}`,
  );
}

async function main() {
  const experiment = process.argv[2] ?? "token-economy";
  if (experiment === "token-economy") {
    await reportTokenEconomy();
    return;
  }
  console.error(`No report renderer yet for experiment "${experiment}".`);
  process.exit(1);
}

main();
