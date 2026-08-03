import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHtmlReport } from "./lib/htmlReport.js";
import { generateNarrative } from "./lib/narrative.js";
import {
  computeAggregate,
  computeAnalysis,
  computeCategoryTokenBreakdown,
  computeCategoryTokenTable,
  computeCorrectnessTable,
  computeStaleSummary,
  computeTaskTable,
  formatTurnsWithToolCalls,
  loadRuns,
  pairedTokenTotals,
  partitionByCurrentDef,
} from "./lib/reportData.js";
import { computeSequenceTokenTable, renderSessionHtmlReport } from "./lib/sessionReport.js";
import { computeTaskDefHash } from "./lib/taskDefHash.js";
import { loadRegistry, loadTasks } from "./lib/taskLoader.js";
import type { SessionEconomyRun } from "./session-economy.js";
import type { TokenEconomyRun } from "./token-economy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Fingerprints every task currently in the registry, keyed by task id — the
 * "ground truth" a historical run's own taskDefHash is compared against to
 * decide whether it's still trustworthy. See partitionByCurrentDef in
 * lib/reportData.ts and docs/results/v0.2.0-realistic-tasks-findings.md's
 * "Stale run-record contamination" section for why this exists.
 */
async function buildCurrentHashByTaskId(): Promise<Map<string, string>> {
  const registry = await loadRegistry();
  const map = new Map<string, string>();
  for (const corpus of registry) {
    const tasks = await loadTasks(corpus.id);
    for (const task of tasks) {
      map.set(task.id, computeTaskDefHash(task));
    }
  }
  return map;
}

/**
 * G_MESH_BENCH_HTML_NARRATIVE=yes|no gates the extra `claude -p` call that
 * turns computeAnalysis()'s bullets into prose for the HTML report. Default
 * yes when unset. Same parsing style/env var as token-economy.ts's
 * shouldGenerateNarrative().
 */
function shouldGenerateNarrative(): boolean {
  const envOverride = process.env.G_MESH_BENCH_HTML_NARRATIVE;
  if (envOverride === undefined) return true;
  const normalized = envOverride.trim().toLowerCase();
  if (["yes", "y", "true"].includes(normalized)) return true;
  if (["no", "n", "false"].includes(normalized)) return false;
  throw new Error(`Invalid G_MESH_BENCH_HTML_NARRATIVE value "${envOverride}"; expected "yes" or "no".`);
}

/**
 * Correctness by arm by category, printed *before* the token table — a task's
 * category/expectedWinner is task-authoring metadata, absent on pre-v2 runs,
 * so those fall into an explicit "uncategorized" bucket rather than being
 * silently dropped or miscounted.
 */
function printCorrectness(runs: TokenEconomyRun[]): void {
  const rows = computeCorrectnessTable(runs);

  console.log("# Correctness report (by category)\n");
  console.log("| Category | Arm | Oracle pass rate |");
  console.log("|---|---|---|");
  for (const row of rows) {
    console.log(`| ${row.category} | ${row.arm} | ${row.passed}/${row.total} |`);
  }
  console.log("");
}

/**
 * Paired gmesh-vs-baseline token savings by category, printed right after the
 * correctness table — the single blended PAIRED reduction number further
 * below averages over all tasks, which hides categories like "multihop"
 * (few tasks, largest g-mesh advantage) inside 17 easier tasks where a fixed
 * per-turn MCP tool-schema cost can outweigh g-mesh's turn savings. Skips
 * categories with zero qualifying pairs rather than printing a bare 0%.
 */
function printCategoryTokenSavings(runs: TokenEconomyRun[]): void {
  const rows = computeCategoryTokenTable(runs);
  if (rows.length === 0) return;

  console.log("# Token savings by category (paired, oracle-passed pairs only)\n");
  console.log("| Category | gmesh mean tokens | baseline mean tokens | Savings | Pairs (n) |");
  console.log("|---|---|---|---|---|");
  for (const row of rows) {
    console.log(
      `| ${row.category} | ${row.gmeshMeanTokens.toFixed(0)} | ${row.baselineMeanTokens.toFixed(0)} | ${row.savingsPct.toFixed(1)}% | ${row.pairCount} |`,
    );
  }
  console.log("");
}

/**
 * Same pairs as printCategoryTokenSavings, split into the four token types
 * Anthropic bills separately (input/output/cache-create/cache-read) instead
 * of the summed total that table shows. The sum hides mechanism: on
 * "lookup", gmesh pays more in BOTH cache-create and cache-read (a fixed
 * schema tax with nothing offsetting it); on "multi-hop"/"ambiguous-name",
 * baseline pays dramatically more in cache-create (each grep/Read round-trip
 * adds fresh, never-cached content) AND more cache-read (a longer transcript
 * from more turns) — a compounding double cost that explains gmesh's win
 * there. Printed right after printCategoryTokenSavings so the two are read
 * together.
 */
function printCategoryTokenBreakdown(runs: TokenEconomyRun[]): void {
  const rows = computeCategoryTokenBreakdown(runs);
  if (rows.length === 0) return;

  console.log("# Token type breakdown by category (paired, oracle-passed pairs only)\n");
  console.log("| Category | Arm | Input | Output | Cache create | Cache read | Pairs (n) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const row of rows) {
    console.log(
      `| ${row.category} | ${row.arm} | ${row.meanInputTokens.toFixed(0)} | ${row.meanOutputTokens.toFixed(0)} | ${row.meanCacheCreationTokens.toFixed(0)} | ${row.meanCacheReadTokens.toFixed(0)} | ${row.pairCount} |`,
    );
  }
  console.log("");
}

/**
 * Printed right after the correctness table, before the token-economy table
 * — only when something was actually excluded (never in --all mode). See
 * docs/results/v0.2.0-realistic-tasks-findings.md, "Stale run-record
 * contamination" for the bug this is surfacing.
 */
function printStaleSummary(stale: TokenEconomyRun[]): void {
  if (stale.length === 0) return;
  const summary = computeStaleSummary(stale);

  console.log("# Excluded as stale\n");
  console.log(
    `${stale.length} run(s) across ${summary.length} task(s) excluded — graded against a superseded task\n` +
      `definition. Re-run \`npm run token-economy\` to refresh, or pass --all to\n` +
      `include them anyway.\n`,
  );
  console.log("| Task | Excluded runs |");
  console.log("|---|---|");
  for (const row of summary) {
    console.log(`| ${row.taskId} | ${row.count} |`);
  }
  console.log("");
}

async function reportTokenEconomy(): Promise<void> {
  const allRuns = await loadRuns<TokenEconomyRun>(path.join(ROOT, "results"), "token-economy");

  const useAll = process.argv.includes("--all");
  let runs = allRuns;
  let stale: TokenEconomyRun[] = [];
  if (!useAll) {
    const currentHashByTaskId = await buildCurrentHashByTaskId();
    const partitioned = partitionByCurrentDef(allRuns, currentHashByTaskId);
    runs = partitioned.current;
    stale = partitioned.stale;
  }

  printCorrectness(runs);
  printCategoryTokenSavings(runs);
  printCategoryTokenBreakdown(runs);
  if (!useAll) printStaleSummary(stale);

  const taskTable = computeTaskTable(runs);

  console.log("# Token economy report\n");
  console.log("| Task | Expected winner | Arm | Reps (ok/total) | Tokens mean | Tokens best | Tokens worst | Cost USD (mean) | Turns (tool calls) | Oracle (pass/ok) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|");

  // Iterates whichever arms the loaded runs actually contain (see
  // reportData.ts's armsPresent) — 2-arm history prints exactly as before,
  // and a run set that includes gmesh-trusted grows a third row per task.
  for (const row of taskTable) {
    for (const { arm, agg, groupLength: group } of row.cells) {
      if (!agg) {
        if (group > 0) {
          console.log(`| ${row.taskId} | ${row.expectedWinner} | ${arm} | 0/${group} | - | - | - | - | - | - |`);
        }
        continue;
      }
      console.log(
        `| ${row.taskId} | ${row.expectedWinner} | ${agg.arm} | ${agg.okCount}/${agg.total} | ${agg.meanTokens.toFixed(0)} | ${agg.bestTokens} | ${agg.worstTokens} | ${agg.meanCostUsd.toFixed(4)} | ${formatTurnsWithToolCalls(agg)} | ${agg.passCount}/${agg.okCount} |`,
      );
    }
  }

  const aggregate = computeAggregate(runs);

  console.log("\n## Aggregate\n");
  console.log(`- Tasks compared: ${aggregate.taskCount}`);
  console.log(`- Total mean tokens — gmesh: ${aggregate.totalGmeshTokens.toFixed(0)}, baseline: ${aggregate.totalBaselineTokens.toFixed(0)}`);
  console.log(`- Token reduction, UNCONDITIONAL (gmesh vs baseline, every ok run regardless of oracle result): ${aggregate.unconditionalReductionPct.toFixed(1)}%`);
  console.log(`- Oracle pass rate — gmesh: ${aggregate.gmeshOracleOk}/${aggregate.gmeshOracleTotal}, baseline: ${aggregate.baselineOracleOk}/${aggregate.baselineOracleTotal}`);

  const paired = pairedTokenTotals(runs);
  const pairedReduction =
    paired.totalBaseline > 0 ? ((paired.totalBaseline - paired.totalGmesh) / paired.totalBaseline) * 100 : 0;
  console.log(
    `- Token reduction, PAIRED (only task/rep pairs where both arms had oraclePassed:true, n=${paired.pairCount} pairs): ${paired.pairCount > 0 ? pairedReduction.toFixed(1) + "%" : "n/a — no pairs where both arms passed oracle"}`,
  );

  let narrativeText: string | null = null;
  if (shouldGenerateNarrative()) {
    const correctnessTable = computeCorrectnessTable(runs);
    const bullets = computeAnalysis(runs, correctnessTable, taskTable, aggregate, paired);
    const narrative = await generateNarrative(bullets, aggregate);
    narrativeText = narrative?.text ?? null;
  }

  const html = renderHtmlReport(runs, { title: "g-mesh-bench cumulative report", narrative: narrativeText });
  const htmlDir = path.join(ROOT, "results/html");
  await mkdir(htmlDir, { recursive: true });
  const htmlPath = path.join(htmlDir, "cumulative.html");
  await writeFile(htmlPath, html);
  console.log(`\nWrote HTML report to ${htmlPath}`);
}

/**
 * The chained-session experiment's cumulative report.
 *
 * Kept entirely separate from reportTokenEconomy's math: computeAggregate and
 * pairedTokenTotals assume every run is an isolated, cold-start measurement,
 * and blending chained-session runs into them would silently change what the
 * headline reduction number means. Same "never merge separate metrics"
 * principle the README already states for the other experiments.
 */
async function reportSessionEconomy(): Promise<void> {
  const dir = path.join(ROOT, "results/session-economy");
  if (!existsSync(dir)) {
    console.error(`No session-economy results yet (${dir} does not exist). Run \`npm run session-economy\` first.`);
    process.exit(1);
  }
  const runs = await loadRuns<SessionEconomyRun>(path.join(ROOT, "results"), "session-economy");

  const sequenceTable = computeSequenceTokenTable(runs);

  console.log("# Session economy report — cost by position in a chained session\n");
  console.log("| Corpus | Arm | Position | Runs (n) | Mean cache-creation tokens | Mean total tokens |");
  console.log("|---|---|---|---|---|---|");
  for (const row of sequenceTable) {
    console.log(
      `| ${row.corpusId} | ${row.arm} | ${row.sequenceIndex} | ${row.n} | ${row.meanCacheCreationTokens.toFixed(0)} | ${row.meanTotalTokens.toFixed(0)} |`,
    );
  }
  console.log("");

  // This experiment's actual finding — cache-read grows with position while
  // cache-creation doesn't — needs all four token types broken out, not just
  // cache-creation-vs-total. See sessionReport.ts's SequencePositionRow doc
  // comment.
  console.log("# Session economy report — token type breakdown by position\n");
  console.log("| Corpus | Arm | Position | Runs (n) | Input | Output | Cache create | Cache read |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const row of sequenceTable) {
    console.log(
      `| ${row.corpusId} | ${row.arm} | ${row.sequenceIndex} | ${row.n} | ${row.meanInputTokens.toFixed(0)} | ${row.meanOutputTokens.toFixed(0)} | ${row.meanCacheCreationTokens.toFixed(0)} | ${row.meanCacheReadTokens.toFixed(0)} |`,
    );
  }

  const skipped = runs.filter((r) => r.status === "skipped").length;
  const errored = runs.filter((r) => r.status === "error" || r.status === "budget_exceeded").length;
  console.log(
    `\n${runs.length} run record(s) loaded — ${runs.filter((r) => r.status === "ok").length} ok, ${skipped} skipped (chain aborted before them), ${errored} failed.`,
  );

  const html = renderSessionHtmlReport(runs, {
    title: "g-mesh-bench session-economy cumulative report",
    narrative: null,
  });
  const htmlDir = path.join(ROOT, "results/html");
  await mkdir(htmlDir, { recursive: true });
  const htmlPath = path.join(htmlDir, "session-cumulative.html");
  await writeFile(htmlPath, html);
  console.log(`\nWrote HTML report to ${htmlPath}`);
}

async function main() {
  // process.argv[2] is normally the experiment name, but `--all` (see
  // reportTokenEconomy) is also passed positionally there (`npm run report --
  // --all`) — skip flag-shaped args when picking the experiment so `--all`
  // alone doesn't get misread as an unknown experiment name.
  const experiment = process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? "token-economy";
  if (experiment === "token-economy") {
    await reportTokenEconomy();
    return;
  }
  if (experiment === "session-economy") {
    await reportSessionEconomy();
    return;
  }
  console.error(`No report renderer yet for experiment "${experiment}".`);
  process.exit(1);
}

main();
