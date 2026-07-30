import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderHtmlReport } from "./lib/htmlReport.js";
import { generateNarrative } from "./lib/narrative.js";
import {
  computeAggregate,
  computeAnalysis,
  computeCorrectnessTable,
  computeTaskTable,
  loadRuns,
  pairedTokenTotals,
} from "./lib/reportData.js";
import type { TokenEconomyRun } from "./token-economy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function reportTokenEconomy(): Promise<void> {
  const runs = await loadRuns<TokenEconomyRun>(path.join(ROOT, "results"), "token-economy");

  printCorrectness(runs);

  const taskTable = computeTaskTable(runs);

  console.log("# Token economy report\n");
  console.log("| Task | Expected winner | Arm | Reps (ok/total) | Tokens mean | Tokens best | Tokens worst | Cost USD (mean) | Oracle (pass/ok) |");
  console.log("|---|---|---|---|---|---|---|---|---|");

  for (const row of taskTable) {
    for (const [arm, group, agg] of [
      ["gmesh", row.gmeshGroupLength, row.gmesh] as const,
      ["baseline", row.baselineGroupLength, row.baseline] as const,
    ]) {
      if (!agg) {
        if (group > 0) {
          console.log(`| ${row.taskId} | ${row.expectedWinner} | ${arm} | 0/${group} | - | - | - | - | - |`);
        }
        continue;
      }
      console.log(
        `| ${row.taskId} | ${row.expectedWinner} | ${agg.arm} | ${agg.okCount}/${agg.total} | ${agg.meanTokens.toFixed(0)} | ${agg.bestTokens} | ${agg.worstTokens} | ${agg.meanCostUsd.toFixed(4)} | ${agg.passCount}/${agg.okCount} |`,
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
