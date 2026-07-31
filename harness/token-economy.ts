import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { MAX_BUDGET_USD, MODEL, armMcpConfig, armPrompt, armTools } from "./lib/armConfig.js";
import { resolveWarm } from "./lib/corpusResolver.js";
import { computeAggregate, computeAnalysis, computeCorrectnessTable, computeTaskTable, pairedTokenTotals } from "./lib/reportData.js";
import { renderHtmlReport } from "./lib/htmlReport.js";
import { JUDGE_MAX_BUDGET_USD } from "./lib/judge.js";
import { gmeshBinaryPath, kungfuBinaryPath } from "./lib/mcpConfig.js";
import { generateNarrative } from "./lib/narrative.js";
import { checkOracle } from "./lib/oracleCheck.js";
import { runClaude } from "./lib/runClaude.js";
import { computeTaskDefHash } from "./lib/taskDefHash.js";
import { loadRegistry, loadTasks } from "./lib/taskLoader.js";
import type { Arm, BenchTask, ExpectedWinner, TaskCategory } from "./lib/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * A judge-mode oracle grades the arm's answer with a second, independent
 * `claude -p` call (lib/judge.ts), capped on its own by JUDGE_MAX_BUDGET_USD.
 * Each cap is enforced inside a separate CLI invocation, so until now nothing
 * bounded the *pair*: a single (task, rep, arm) run could spend MAX_BUDGET_USD
 * on the arm and then quietly spend more on grading, outside the harness's
 * budget logic entirely.
 *
 * The ceiling is the sum of the two per-call caps rather than something
 * tighter on purpose: any run that respected both individual caps must fall
 * under it, so crossing it means a cap was overshot (or a call was made that
 * this accounting doesn't know about) — not that the run was legitimately
 * expensive. That makes it a real invariant rather than a second throttle.
 */
export const MAX_COMBINED_BUDGET_USD = MAX_BUDGET_USD + JUDGE_MAX_BUDGET_USD;

/**
 * "skipped" is produced only by session-economy.ts, which aborts the rest of a
 * chained session once one call in it fails — every later task in that chain
 * is recorded as skipped rather than silently omitted, so the run set says
 * *why* a measurement is missing. token-economy.ts itself never emits it, and
 * every consumer tests `status === "ok"` rather than switching exhaustively,
 * so the extra member changes nothing downstream.
 */
export type RunStatus = "ok" | "error" | "budget_exceeded" | "skipped";

export interface TokenEconomyRun {
  taskId: string;
  corpusId: string;
  arm: Arm;
  repetition: number;
  timestamp: string;
  model: string;
  /** Task-authoring metadata, copied through for report.ts grouping; absent on pre-v2 tasks that declare neither. */
  category?: TaskCategory;
  expectedWinner?: ExpectedWinner;
  /** Fingerprint of the full task definition (see lib/taskDefHash.ts) this run was graded against — lets report.ts detect runs whose task prompt/oracle has since been edited. Absent on runs recorded before this field existed. */
  taskDefHash: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  durationMs: number;
  /** Arm call only. Judge spend is kept out of this number and reported beside it as judgeCostUsd. */
  costUsd: number;
  /** Grading spend for this run: >0 only for judge-mode oracles, 0 otherwise. Never merged into costUsd. */
  judgeCostUsd: number;
  resultText: string;
  oraclePassed: boolean;
  /** Judge's one-line rationale, judge mode only — kept so a judge verdict can be audited after the fact. */
  judgeReason?: string;
  status: RunStatus;
}

/**
 * Status of one (task, rep, arm) run once grading spend is taken into account.
 *
 * This is the only place arm and judge cost are added together, and only to
 * decide whether the pair blew MAX_COMBINED_BUDGET_USD — the two stay separate
 * in the record, because judge cost is grading infrastructure and folding it
 * into either arm's number would corrupt the gmesh/baseline comparison.
 *
 * Trade-off: flagging an otherwise-successful arm call as "budget_exceeded"
 * discards its measurement downstream (report.ts aggregates status === "ok"
 * runs only). That's deliberate — a run that overshot a cap is anomalous, and
 * silently averaging it into the headline token number is exactly the failure
 * this accounting exists to catch.
 *
 * Pure and exported so the budget_exceeded path is testable without spending
 * real API money (see harness/budgetAccounting.test.ts).
 */
export function combinedBudgetStatus(armStatus: RunStatus, armCostUsd: number, judgeCostUsd: number): RunStatus {
  // A run that already failed keeps its own, more specific status.
  if (armStatus !== "ok") return armStatus;
  // Strict >: landing exactly on the ceiling is still within budget.
  if (armCostUsd + judgeCostUsd > MAX_COMBINED_BUDGET_USD) return "budget_exceeded";
  return "ok";
}

const REPETITION_PRESETS = { low: 1, normal: 3, max: 5 } as const;
type RepetitionMode = keyof typeof REPETITION_PRESETS;

/**
 * G_MESH_BENCH_REPS selects how many times each (task, arm) pair is run so
 * results can be averaged out — v1 ran each once, which turned out too noisy
 * to trust for before/after comparisons (see architecture doc's Open
 * Questions). Each repetition is a full runClaude() call (real API spend),
 * so this multiplies total run cost by the chosen preset. "low" (1 run) is
 * for a quick sanity check, not for trusting the resulting numbers.
 */
function repetitionCount(): number {
  const raw = process.env.G_MESH_BENCH_REPS ?? "normal";
  const normalized = raw.trim().toLowerCase();
  if (normalized in REPETITION_PRESETS) return REPETITION_PRESETS[normalized as RepetitionMode];
  throw new Error(`Invalid G_MESH_BENCH_REPS value "${raw}"; expected "low", "normal", or "max".`);
}

/**
 * Extra CLI args (`npm run token-economy -- id1 id2`) select a subset of
 * task ids to run instead of the full registry — useful for cheaply
 * re-testing one or two tasks without paying for the whole batch. Empty
 * argv (the common case) means "run everything", unchanged from before this
 * existed.
 */
function requestedTaskIds(): string[] {
  return process.argv.slice(2);
}

async function runArm(
  cwd: string,
  task: BenchTask,
  corpusId: string,
  arm: Arm,
  repetition: number,
  timestamp: string,
): Promise<TokenEconomyRun> {
  const result = await runClaude({
    cwd,
    prompt: armPrompt(task.prompt, arm),
    mcpConfig: armMcpConfig(arm),
    tools: armTools(arm),
    model: MODEL,
    maxBudgetUsd: MAX_BUDGET_USD,
  });
  // Grading a failed arm run is pointless and, in judge mode, not free:
  // runClaude returns an empty resultText for both "error" and
  // "budget_exceeded", so every oracle mode scores it as a miss anyway — but a
  // judge would first pay for a real API call to say so. Skipping it is the
  // prospective half of the combined budget bound; combinedBudgetStatus below
  // is the retrospective half.
  const oracle = result.status === "ok" ? await checkOracle(result.resultText, task.oracle) : undefined;
  const judgeCostUsd = oracle?.judgeCostUsd ?? 0;
  const status = combinedBudgetStatus(result.status, result.costUsd, judgeCostUsd);
  if (status === "budget_exceeded" && result.status === "ok") {
    console.warn(
      `  ! ${task.id} (${arm}, rep ${repetition}): arm $${result.costUsd.toFixed(4)} + judge ` +
        `$${judgeCostUsd.toFixed(4)} exceeds the combined ceiling $${MAX_COMBINED_BUDGET_USD.toFixed(4)}; ` +
        `recording this run as budget_exceeded.`,
    );
  }
  return {
    taskId: task.id,
    corpusId,
    arm,
    repetition,
    timestamp,
    model: MODEL,
    category: task.category,
    expectedWinner: task.expectedWinner,
    taskDefHash: computeTaskDefHash(task),
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
    numTurns: result.numTurns,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    judgeCostUsd,
    resultText: result.resultText,
    oraclePassed: oracle?.passed ?? false,
    judgeReason: oracle?.reason,
    status,
  };
}

/**
 * G_MESH_BENCH_HTML_NARRATIVE=yes|no gates the extra `claude -p` call that
 * turns computeAnalysis()'s bullets into prose for the HTML report. Default
 * yes when unset, so a plain `npm run token-economy` gets a narrative without
 * extra flags — set to "no" to skip the call entirely (no spend, no API
 * dependency) for a fast/offline/CI-only report. Same parsing style as
 * shouldWarmCache() above.
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
 * G_MESH_BENCH_INCLUDE_TRUSTED=yes|no gates the third `gmesh-trusted` arm.
 *
 * Default no: the run is then byte-for-byte what it was before this arm
 * existed — same two arms, same output shape, same spend. Set to yes to also
 * run gmesh-trusted for every (task, repetition), which adds a full third arm
 * call to each one (~1.5x the API spend of the usual two-arm run). Same
 * parsing style as shouldWarmCache()/shouldGenerateNarrative().
 */
function shouldIncludeTrustedArm(): boolean {
  const envOverride = process.env.G_MESH_BENCH_INCLUDE_TRUSTED;
  if (envOverride === undefined) return false;
  const normalized = envOverride.trim().toLowerCase();
  if (["yes", "y", "true"].includes(normalized)) return true;
  if (["no", "n", "false"].includes(normalized)) return false;
  throw new Error(`Invalid G_MESH_BENCH_INCLUDE_TRUSTED value "${envOverride}"; expected "yes" or "no".`);
}

/**
 * G_MESH_BENCH_INCLUDE_KUNGFU=yes|no gates the external `kungfu` comparison
 * arm — same opt-in-only pattern as shouldIncludeTrustedArm(), for the same
 * reason: a default run's output must stay exactly what it was before this
 * arm existed. kungfu is a separately-installed, unvendored third-party tool
 * (see mcpConfig.ts's kungfuBinaryPath), so this also gates the extra
 * preflight check in main().
 */
function shouldIncludeKungfuArm(): boolean {
  const envOverride = process.env.G_MESH_BENCH_INCLUDE_KUNGFU;
  if (envOverride === undefined) return false;
  const normalized = envOverride.trim().toLowerCase();
  if (["yes", "y", "true"].includes(normalized)) return true;
  if (["no", "n", "false"].includes(normalized)) return false;
  throw new Error(`Invalid G_MESH_BENCH_INCLUDE_KUNGFU value "${envOverride}"; expected "yes" or "no".`);
}

const WARMUP_PROMPT = 'Reply with just the word "ok" and nothing else.';

/**
 * Decide whether to warm the prompt cache before the benchmark loop.
 *
 * G_MESH_BENCH_WARM_CACHE=yes|no short-circuits the interactive question, for
 * scripted/CI invocations. If it's unset and stdin isn't a TTY (e.g. piped
 * input, CI runner), we can't safely block on readline.question() forever —
 * skipping warm-up is the safe default there since it just reproduces today's
 * behavior rather than silently hanging the run.
 */
async function shouldWarmCache(): Promise<boolean> {
  const envOverride = process.env.G_MESH_BENCH_WARM_CACHE;
  if (envOverride !== undefined) {
    const normalized = envOverride.trim().toLowerCase();
    if (["yes", "y", "true"].includes(normalized)) return true;
    if (["no", "n", "false"].includes(normalized)) return false;
    throw new Error(`Invalid G_MESH_BENCH_WARM_CACHE value "${envOverride}"; expected "yes" or "no".`);
  }

  if (!process.stdin.isTTY) {
    console.log(
      "stdin is not a TTY and G_MESH_BENCH_WARM_CACHE is unset; skipping interactive prompt and defaulting to no warm-up.",
    );
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Warm the prompt cache before running? (y/n): ");
    return ["y", "yes"].includes(answer.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

/** One throwaway call per arm so the system-prompt/tool-schema prefix is warm before any measured run. */
async function warmArm(cwd: string, arm: Arm): Promise<void> {
  const result = await runClaude({
    cwd,
    prompt: WARMUP_PROMPT,
    mcpConfig: armMcpConfig(arm),
    tools: armTools(arm),
    model: MODEL,
    maxBudgetUsd: MAX_BUDGET_USD,
  });
  if (result.status !== "ok") {
    throw new Error(
      `Cache warm-up call for arm "${arm}" did not succeed (status: "${result.status}"). ` +
        `Aborting rather than running the benchmark against an unknown cache state.`,
    );
  }
}

/**
 * Two calls, not three, even when gmesh-trusted is enabled: what gets warmed
 * is the system-prompt/tool-schema prefix, and gmesh-trusted's is identical to
 * gmesh's (same MCP config, same tool list) — the arms differ only after that
 * prefix, in the user prompt. A third warm-up would spend money to warm a
 * cache entry that is already warm.
 */
async function warmCache(cwd: string, includeKungfu: boolean): Promise<void> {
  console.log("Warming prompt cache: gmesh arm...");
  await warmArm(cwd, "gmesh");
  console.log("Warming prompt cache: baseline arm...");
  await warmArm(cwd, "baseline");
  if (includeKungfu) {
    // kungfu's MCP config/tool list differs from gmesh's, so it needs its own
    // warm-up call — unlike gmesh-trusted, it does not share gmesh's prefix.
    console.log("Warming prompt cache: kungfu arm...");
    await warmArm(cwd, "kungfu");
  }
}

/**
 * kungfuBinaryPath() defaults to the bare command "kungfu", resolved via
 * PATH by the OS at spawn time (see mcpConfig.ts) — existsSync can't check
 * that directly, so a bare name is checked with `which`/PATH lookup while a
 * path override (contains a separator) is checked as a real path, same as
 * gmeshBinaryPath().
 */
function kungfuBinaryIsAvailable(): boolean {
  const bin = kungfuBinaryPath();
  if (bin.includes(path.sep)) return existsSync(bin);
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir.length > 0 && existsSync(path.join(dir, bin)));
}

async function main() {
  if (!existsSync(gmeshBinaryPath())) {
    console.error(
      `g-mesh binary not found at ${gmeshBinaryPath()}. Build it first:\n` +
        `  cd ../g-mesh/core && cargo build --release\n` +
        `  cd ../g-mesh/plugins/js-ts && npm install && npm run build`,
    );
    process.exit(1);
  }

  const includeKungfu = shouldIncludeKungfuArm();
  if (includeKungfu && !kungfuBinaryIsAvailable()) {
    console.error(
      `G_MESH_BENCH_INCLUDE_KUNGFU=yes but kungfu binary "${kungfuBinaryPath()}" was not found on PATH. ` +
        `Install it (see https://github.com/denyzhirkov/kungfu) or set G_MESH_BENCH_KUNGFU_BINARY to its path.`,
    );
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  const registry = await loadRegistry();
  const tasksByCorpus = new Map<string, BenchTask[]>();
  for (const corpus of registry) tasksByCorpus.set(corpus.id, await loadTasks(corpus.id));

  const selectedTaskIds = requestedTaskIds();
  if (selectedTaskIds.length > 0) {
    const knownIds = new Set([...tasksByCorpus.values()].flat().map((t) => t.id));
    const unknown = selectedTaskIds.filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown task id(s): ${unknown.join(", ")}`);
    }
    const total = [...tasksByCorpus.values()].flat().length;
    console.log(`Running ${selectedTaskIds.length} of ${total} tasks: ${selectedTaskIds.join(", ")}`);
  }

  const runs: TokenEconomyRun[] = [];

  if (await shouldWarmCache()) {
    const firstCorpus = registry[0];
    if (!firstCorpus) {
      throw new Error("Cannot warm cache: corpus registry is empty.");
    }
    const warmupCwd = await resolveWarm(firstCorpus);
    await warmCache(warmupCwd, includeKungfu);
  }

  const reps = repetitionCount();
  console.log(`Repetitions per (task, arm): ${reps}`);

  // Only ever logged when a flag is on, so a default run's output is
  // unchanged from before these extra arms existed.
  const arms: Arm[] = ["gmesh", "baseline"];
  if (shouldIncludeTrustedArm()) arms.push("gmesh-trusted");
  if (includeKungfu) arms.push("kungfu");
  if (arms.length > 2) {
    console.log(
      `Arms per (task, rep): ${arms.join(", ")}. Extra arms are full extra runs of every task: ` +
        `expect roughly ${(arms.length / 2).toFixed(1)}x the API spend of a two-arm run.`,
    );
  }

  for (const corpus of registry) {
    const corpusTasks = tasksByCorpus.get(corpus.id) ?? [];
    const tasks =
      selectedTaskIds.length > 0 ? corpusTasks.filter((t) => selectedTaskIds.includes(t.id)) : corpusTasks;
    if (tasks.length === 0) continue;
    const cwd = await resolveWarm(corpus);

    for (const task of tasks) {
      for (let rep = 1; rep <= reps; rep++) {
        for (const arm of arms) {
          console.log(`[${corpus.id}] ${task.id}: ${arm} arm (rep ${rep}/${reps})...`);
          runs.push(await runArm(cwd, task, corpus.id, arm, rep, timestamp));
        }
      }
    }
  }

  const resultsDir = path.join(ROOT, "results/token-economy");
  await mkdir(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${timestamp.replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify(runs, null, 2));
  console.log(`Wrote ${runs.length} run records to ${outPath}`);

  // Reported separately from arm spend, never summed with it, so grading cost
  // is visible as its own line item rather than hiding inside the comparison.
  const armSpend = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const judgeSpend = runs.reduce((sum, r) => sum + r.judgeCostUsd, 0);

  // Narrative spend is a third, separate line item — same "own budget, never
  // summed into costUsd" pattern as judge spend above. 0 when the narrative
  // is disabled or the call failed, never merged into armSpend/judgeSpend.
  let narrativeSpend = 0;
  let narrativeText: string | null = null;
  if (shouldGenerateNarrative()) {
    const correctnessTable = computeCorrectnessTable(runs);
    const taskTable = computeTaskTable(runs);
    const aggregate = computeAggregate(runs);
    const paired = pairedTokenTotals(runs);
    const bullets = computeAnalysis(runs, correctnessTable, taskTable, aggregate, paired);
    const narrative = await generateNarrative(bullets, aggregate);
    narrativeText = narrative?.text ?? null;
    narrativeSpend = narrative?.costUsd ?? 0;
  }

  const html = renderHtmlReport(runs, { title: "g-mesh-bench token-economy run", narrative: narrativeText });
  const htmlDir = path.join(ROOT, "results/html");
  await mkdir(htmlDir, { recursive: true });
  const htmlPath = path.join(htmlDir, `${timestamp.replace(/[:.]/g, "-")}.html`);
  await writeFile(htmlPath, html);
  console.log(`Wrote HTML report to ${htmlPath}`);

  console.log(
    `Arm spend: $${armSpend.toFixed(4)} | judge (grading) spend: $${judgeSpend.toFixed(4)} | narrative spend: $${narrativeSpend.toFixed(4)}`,
  );
  const overBudget = runs.filter((r) => r.status === "budget_exceeded").length;
  if (overBudget > 0) console.log(`Runs recorded as budget_exceeded: ${overBudget}`);
}

/**
 * Only auto-run when this file is the process entry point, so the module can be
 * imported (harness/budgetAccounting.test.ts imports combinedBudgetStatus)
 * without kicking off a real, API-spending benchmark. `npm run token-economy`
 * is unaffected: tsx sets argv[1] to this file's path.
 */
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
