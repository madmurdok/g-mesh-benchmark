import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  GMESH_CONFIGURED_CLAUDE_MD,
  KUNGFU_CONFIGURED_CLAUDE_MD,
  MAX_BUDGET_USD,
  MODEL,
  armDisallowedTools,
  armMcpConfig,
  armPrompt,
  armTools,
} from "./lib/armConfig.js";
import { resolveConfigured, resolveFresh, resolveWarm, warmGmeshIndex } from "./lib/corpusResolver.js";
import { computeAggregate, computeAnalysis, computeCorrectnessTable, computeTaskTable, pairedTokenTotals } from "./lib/reportData.js";
import { renderHtmlReport } from "./lib/htmlReport.js";
import { JUDGE_MAX_BUDGET_USD } from "./lib/judge.js";
import { gmeshBinaryPath, kungfuBinaryPath } from "./lib/mcpConfig.js";
import { generateNarrative } from "./lib/narrative.js";
import { checkOracle } from "./lib/oracleCheck.js";
import { runClaude } from "./lib/runClaude.js";
import { runAcceptanceTest } from "./lib/testRunner.js";
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
  /**
   * Tool calls this run made, split by purpose (see runClaude.ts's
   * classifyToolCall): `search` is Read/Grep/Glob plus every `mcp__*` tool,
   * `edit` is Edit/Write, `other` is anything else. Flat rather than nested to
   * match the rest of this interface.
   *
   * Optional because runs recorded before the harness could see per-turn tool
   * names (it read only the CLI's final aggregate) genuinely don't have them —
   * same reason `category`/`expectedWinner` are optional. Consumers must treat
   * `undefined` as "unknown", not as 0.
   */
  searchToolCalls?: number;
  editToolCalls?: number;
  otherToolCalls?: number;
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
 * Which of excalidraw's `implementation` tasks a full, unfiltered run
 * includes, ordered by measured API spend per arm call (the test commands cost
 * about the same as each other — they're all dominated by the same `yarn
 * install`, so what actually varies is the agent):
 *
 *   elbow-zero-position   ~$0.23-0.25
 *   linear-editor-order   ~$0.20-0.27
 *   library-dedup         ~$0.80-1.05
 *
 * library-dedup is last on purpose. It is the only one of the three that
 * regularly runs into MAX_BUDGET_USD — both arms have been observed producing
 * a correct fix and still being recorded `budget_exceeded` before grading, so
 * a run that includes it can spend real money and learn nothing. Keeping it
 * behind an explicit `high` makes that an opt-in rather than the default.
 */
const EXCALIDRAW_IMPLEMENTATION_SCOPE_PRESETS = {
  low: ["ex-implement-mutateelement-elbow-zero-position"],
  normal: ["ex-implement-mutateelement-elbow-zero-position", "ex-implement-linear-editor-order-crash"],
  high: [
    "ex-implement-mutateelement-elbow-zero-position",
    "ex-implement-linear-editor-order-crash",
    "ex-implement-library-dedup",
  ],
} as const;
type ExcalidrawScopeMode = keyof typeof EXCALIDRAW_IMPLEMENTATION_SCOPE_PRESETS;

/**
 * G_MESH_BENCH_EXCALIDRAW_SCOPE picks how many of excalidraw's
 * `implementation` tasks a full registry run covers. Unlike every other
 * `implementation` task, these each pay excalidraw's ~90s `yarn install` into
 * a throwaway clone *per (task, arm, repetition)* before their test command
 * can run at all, so running all three by default would add roughly half an
 * hour of pure install time to an otherwise unchanged benchmark.
 *
 * Defaults to "low" — the same "expensive extras are opt-in" stance as
 * G_MESH_BENCH_INCLUDE_TRUSTED and friends, except this one can't default to
 * nothing: these are real corpus tasks, so the floor is the cheapest single
 * one rather than zero.
 */
export function excalidrawImplementationScope(): readonly string[] {
  const raw = process.env.G_MESH_BENCH_EXCALIDRAW_SCOPE ?? "low";
  const normalized = raw.trim().toLowerCase();
  if (normalized in EXCALIDRAW_IMPLEMENTATION_SCOPE_PRESETS) {
    return EXCALIDRAW_IMPLEMENTATION_SCOPE_PRESETS[normalized as ExcalidrawScopeMode];
  }
  throw new Error(
    `Invalid G_MESH_BENCH_EXCALIDRAW_SCOPE value "${raw}"; expected "low", "normal", or "high".`,
  );
}

/**
 * Which of a corpus's tasks this run actually executes.
 *
 * Two independent filters, in precedence order: an explicit CLI selection
 * means "run exactly these" and short-circuits everything else, the way it
 * already overrides every other default in this harness. Otherwise the
 * excalidraw scope preset applies — and only to excalidraw's `implementation`
 * tasks, since it exists to cap that corpus's per-run `yarn install` bill;
 * task-tracker-mcp's own `implementation` task installs in ~11s and is never
 * gated by it.
 *
 * Pulled out of main()'s loop so the precedence is testable without running a
 * benchmark (see token-economy.test.ts).
 */
export function selectTasksForCorpus(
  corpusId: string,
  corpusTasks: readonly BenchTask[],
  selectedTaskIds: readonly string[],
  excalidrawScope: readonly string[],
): BenchTask[] {
  if (selectedTaskIds.length > 0) {
    return corpusTasks.filter((t) => selectedTaskIds.includes(t.id));
  }
  return corpusTasks.filter(
    (t) =>
      corpusId !== "excalidraw" ||
      t.category !== "implementation" ||
      excalidrawScope.includes(t.id),
  );
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

/**
 * Whether a task's agent needs write access to its cwd — true only for
 * `oracle.mode === "test"` tasks, which are graded on the edits they make
 * rather than on what they say. Also the trigger for giving such a task its
 * own throwaway clone in main(): the two must stay in lockstep, so both read
 * this one predicate.
 */
function taskEditsCode(task: BenchTask): boolean {
  return task.oracle.mode === "test";
}

/** The pass/fail verdict for one run, normalized across the two grading paths (see gradeRun). */
interface GradingOutcome {
  passed: boolean;
  reason?: string;
  /** Real API spend for grading: judge mode only; test mode runs a local process and spends nothing. */
  judgeCostUsd: number;
}

/**
 * Routes a finished run to the grader its oracle mode calls for: test-mode
 * oracles are graded by running the corpus's test suite against the (edited)
 * cwd, every other mode by text-checking the answer. The two produce
 * deliberately different shapes — see lib/testRunner.ts for why they aren't one
 * function — so they're normalized here, at the single point runArm consumes.
 */
async function gradeRun(cwd: string, resultText: string, task: BenchTask): Promise<GradingOutcome> {
  if (taskEditsCode(task)) {
    const verdict = await runAcceptanceTest(cwd, task.oracle);
    return { passed: verdict.passed, reason: verdict.reason, judgeCostUsd: 0 };
  }
  const verdict = await checkOracle(resultText, task.oracle);
  return { passed: verdict.passed, reason: verdict.reason, judgeCostUsd: verdict.judgeCostUsd ?? 0 };
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
    tools: armTools(arm, { allowEdit: taskEditsCode(task) }),
    disallowedTools: armDisallowedTools(arm),
    model: MODEL,
    maxBudgetUsd: MAX_BUDGET_USD,
  });
  // Grading a failed arm run is pointless and, in judge mode, not free:
  // runClaude returns an empty resultText for both "error" and
  // "budget_exceeded", so every oracle mode scores it as a miss anyway — but a
  // judge would first pay for a real API call to say so. Skipping it is the
  // prospective half of the combined budget bound; combinedBudgetStatus below
  // is the retrospective half. A test-mode oracle is skipped for the same
  // reason minus the money: an agent that errored out or ran out of budget
  // mid-edit may well have left the corpus half-edited, and grading that says
  // nothing about the arm.
  const oracle = result.status === "ok" ? await gradeRun(cwd, result.resultText, task) : undefined;
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
    searchToolCalls: result.toolCalls.search,
    editToolCalls: result.toolCalls.edit,
    otherToolCalls: result.toolCalls.other,
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

/**
 * G_MESH_BENCH_INCLUDE_BARE_GMESH=yes|no gates the bare `gmesh` arm, which is
 * no longer part of a default run.
 *
 * The swap: `gmesh-configured` — g-mesh plus the CLAUDE.md guidance an actual
 * project would have — is what real usage looks like, so it is what the
 * default two-arm comparison now measures. Bare `gmesh` (the tools with no
 * guidance at all) measures a configuration nobody ships, so it drops to the
 * same opt-in tier as gmesh-trusted/kungfu rather than being paid for on every
 * run. Turn it on to reproduce the old bare-vs-baseline comparison, or to
 * measure what the CLAUDE.md itself is worth (bare vs configured, side by side).
 *
 * This replaces the former G_MESH_BENCH_INCLUDE_CONFIGURED flag, which gated
 * the arm that is now unconditional — keeping it would have meant a flag whose
 * only effect was to add a second, duplicate copy of an arm already running.
 */
function shouldIncludeBareGmeshArm(): boolean {
  const envOverride = process.env.G_MESH_BENCH_INCLUDE_BARE_GMESH;
  if (envOverride === undefined) return false;
  const normalized = envOverride.trim().toLowerCase();
  if (["yes", "y", "true"].includes(normalized)) return true;
  if (["no", "n", "false"].includes(normalized)) return false;
  throw new Error(`Invalid G_MESH_BENCH_INCLUDE_BARE_GMESH value "${envOverride}"; expected "yes" or "no".`);
}

/**
 * G_MESH_BENCH_INCLUDE_KUNGFU_CONFIGURED=yes|no gates the `kungfu-configured`
 * arm — same opt-in-only pattern as the other should*Arm functions above, for
 * the same reason: a default run's output must stay exactly what it was
 * before this arm existed. Also gates the kungfu-binary preflight check in
 * main(), same as shouldIncludeKungfuArm() does for plain `kungfu`.
 */
function shouldIncludeKungfuConfiguredArm(): boolean {
  const envOverride = process.env.G_MESH_BENCH_INCLUDE_KUNGFU_CONFIGURED;
  if (envOverride === undefined) return false;
  const normalized = envOverride.trim().toLowerCase();
  if (["yes", "y", "true"].includes(normalized)) return true;
  if (["no", "n", "false"].includes(normalized)) return false;
  throw new Error(`Invalid G_MESH_BENCH_INCLUDE_KUNGFU_CONFIGURED value "${envOverride}"; expected "yes" or "no".`);
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
    disallowedTools: armDisallowedTools(arm),
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
 * One call per *distinct cache prefix*, not one per arm: what gets warmed is
 * the system-prompt/tool-schema prefix, and gmesh-trusted's is identical to
 * gmesh's (same MCP config, same tool list) — those two arms differ only after
 * that prefix, in the user prompt. An extra warm-up would spend money to warm
 * a cache entry that is already warm.
 *
 * The gmesh warm-up is therefore skipped entirely unless an arm that shares
 * that prefix (bare `gmesh` or `gmesh-trusted`, both opt-in now) is actually
 * running — gmesh-configured's CLAUDE.md is system-level context, so its
 * prefix is a different one, warmed from its own cwd below.
 */
async function warmCache(
  arms: readonly Arm[],
  cwd: string,
  kungfuCwd: string | undefined,
  configuredCwd: string | undefined,
  kungfuConfiguredCwd: string | undefined,
): Promise<void> {
  if (arms.includes("gmesh") || arms.includes("gmesh-trusted")) {
    console.log("Warming prompt cache: gmesh arm...");
    await warmArm(cwd, "gmesh");
  }
  console.log("Warming prompt cache: baseline arm...");
  await warmArm(cwd, "baseline");
  if (kungfuCwd !== undefined) {
    // kungfu's MCP config/tool list differs from gmesh's, so it needs its own
    // warm-up call — unlike gmesh-trusted, it does not share gmesh's prefix.
    // Uses a throwaway clone, not `cwd`, for the same reason as the main loop
    // below: kungfu indexes into a .kungfu/ dir inside its cwd, which must
    // never be the live registry-registered checkout.
    console.log("Warming prompt cache: kungfu arm...");
    await warmArm(kungfuCwd, "kungfu");
  }
  if (configuredCwd !== undefined) {
    // Unlike gmesh-trusted (whose only difference from gmesh is in the *user*
    // turn, appended after the cached prefix), gmesh-configured's CLAUDE.md
    // loads as *system*-level context alongside the tool schemas — so its
    // cache prefix genuinely differs from plain gmesh's and needs its own
    // warm-up call, same reasoning as why kungfu gets one above.
    console.log("Warming prompt cache: gmesh-configured arm...");
    await warmArm(configuredCwd, "gmesh-configured");
  }
  if (kungfuConfiguredCwd !== undefined) {
    // Same reasoning as gmesh-configured above: kungfu-configured's CLAUDE.md
    // is system-level context loaded alongside kungfu's tool schemas, so its
    // cache prefix differs from plain kungfu's and isn't shared with it.
    console.log("Warming prompt cache: kungfu-configured arm...");
    await warmArm(kungfuConfiguredCwd, "kungfu-configured");
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
  const includeBareGmesh = shouldIncludeBareGmeshArm();
  const includeKungfuConfigured = shouldIncludeKungfuConfiguredArm();
  if ((includeKungfu || includeKungfuConfigured) && !kungfuBinaryIsAvailable()) {
    console.error(
      `G_MESH_BENCH_INCLUDE_KUNGFU=yes or G_MESH_BENCH_INCLUDE_KUNGFU_CONFIGURED=yes but kungfu binary ` +
        `"${kungfuBinaryPath()}" was not found on PATH. Install it (see https://github.com/denyzhirkov/kungfu) ` +
        `or set G_MESH_BENCH_KUNGFU_BINARY to its path.`,
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

  // Resolved (and therefore validated) before anything spends money, so a
  // typo'd preset name fails immediately instead of after the cache warm-up
  // and the first few runs.
  const excalidrawScope = excalidrawImplementationScope();

  const runs: TokenEconomyRun[] = [];

  // gmesh-configured, not bare gmesh, is the default primary arm: the
  // benchmark's claim is about g-mesh as it is actually used, and nobody
  // actually runs it without the CLAUDE.md guidance. Bare gmesh is opt-in (see
  // shouldIncludeBareGmeshArm). Every other arm stays opt-in as before, so the
  // extra-arm warning below is still only ever logged when a flag is on.
  const arms: Arm[] = ["gmesh-configured", "baseline"];
  if (includeBareGmesh) arms.push("gmesh");
  if (shouldIncludeTrustedArm()) arms.push("gmesh-trusted");
  if (includeKungfu) arms.push("kungfu");
  if (includeKungfuConfigured) arms.push("kungfu-configured");
  if (arms.length > 2) {
    console.log(
      `Arms per (task, rep): ${arms.join(", ")}. Extra arms are full extra runs of every task: ` +
        `expect roughly ${(arms.length / 2).toFixed(1)}x the API spend of a two-arm run.`,
    );
  }

  // After the arm list, not before it: which cache prefixes are worth warming
  // is entirely a function of which arms are running.
  if (await shouldWarmCache()) {
    const firstCorpus = registry[0];
    if (!firstCorpus) {
      throw new Error("Cannot warm cache: corpus registry is empty.");
    }
    const warmupCwd = await resolveWarm(firstCorpus);
    const warmupKungfuCwd = includeKungfu ? await resolveFresh(firstCorpus) : undefined;
    const warmupConfiguredCwd = await resolveConfigured(firstCorpus, GMESH_CONFIGURED_CLAUDE_MD);
    const warmupKungfuConfiguredCwd = includeKungfuConfigured
      ? await resolveConfigured(firstCorpus, KUNGFU_CONFIGURED_CLAUDE_MD)
      : undefined;
    await warmCache(arms, warmupCwd, warmupKungfuCwd, warmupConfiguredCwd, warmupKungfuConfiguredCwd);
  }

  const reps = repetitionCount();
  console.log(`Repetitions per (task, arm): ${reps}`);

  for (const corpus of registry) {
    const corpusTasks = tasksByCorpus.get(corpus.id) ?? [];
    const tasks = selectTasksForCorpus(corpus.id, corpusTasks, selectedTaskIds, excalidrawScope);
    if (tasks.length === 0) continue;
    const cwd = await resolveWarm(corpus);
    // resolveWarm() reuses the same absolute path across runs, so g-mesh's
    // index there is only cold on the very first-ever invocation against
    // this cache path - warm it explicitly anyway so that first run isn't
    // unluckier than every one after it. Gated on the bare `gmesh` arm
    // actually running: `baseline` never calls g-mesh, and gmesh-configured
    // uses `configuredCwd` below instead of this shared `cwd`.
    if (arms.includes("gmesh")) {
      console.log(`[${corpus.id}] warming g-mesh index for the bare gmesh arm's shared checkout...`);
      await warmGmeshIndex(cwd);
    }
    // The three shared per-corpus clones below exist only for read-only tasks:
    // an edit task resolves its own clone per (task, arm, rep) instead. Skip
    // them entirely when this corpus is running edit tasks only, or a run
    // naming just `ex-implement-...` would pay for a full extra excalidraw
    // clone (now once per default run, since gmesh-configured is no longer
    // opt-in) and never read it.
    const hasReadOnlyTask = tasks.some((t) => !taskEditsCode(t));
    // kungfu writes a .kungfu/ index directory into its cwd — unlike g-mesh,
    // which indexes into ~/.g-mesh, never the project dir. Running it against
    // the shared `cwd` above would plant that directory inside the live,
    // registry-registered checkout, which this experiment must not touch (see
    // task #57's explicit constraint). One throwaway clone per corpus, reused
    // across every kungfu-arm call for that corpus, same resolveFresh()
    // precedent used elsewhere in this harness for exactly this reason.
    const kungfuCwd = hasReadOnlyTask && arms.includes("kungfu") ? await resolveFresh(corpus) : undefined;
    // gmesh-configured needs a real CLAUDE.md written into its cwd — for the
    // same reason kungfu gets a throwaway clone above, this must never touch
    // the live, registry-registered checkout, so it gets its own fresh clone
    // with the trust snippet appended to (or creating) a CLAUDE.md there.
    const configuredCwd = hasReadOnlyTask && arms.includes("gmesh-configured")
      ? await resolveConfigured(corpus, GMESH_CONFIGURED_CLAUDE_MD)
      : undefined;
    // This clone is brand-new every corpus (resolveConfigured() always
    // mkdtemp()s), so g-mesh's own index for it is cold every time - warm it
    // once here, before any task in the loop below reuses this same cwd for
    // its first measured g-mesh call.
    if (configuredCwd !== undefined) {
      console.log(`[${corpus.id}] warming g-mesh index for the shared gmesh-configured checkout...`);
      await warmGmeshIndex(configuredCwd);
    }
    // kungfu-configured needs its own throwaway clone for the same reason
    // gmesh-configured does above: a real CLAUDE.md must be written into its
    // cwd, and that must never be the live, registry-registered checkout.
    const kungfuConfiguredCwd = hasReadOnlyTask && arms.includes("kungfu-configured")
      ? await resolveConfigured(corpus, KUNGFU_CONFIGURED_CLAUDE_MD)
      : undefined;

    for (const task of tasks) {
      for (let rep = 1; rep <= reps; rep++) {
        for (const arm of arms) {
          console.log(`[${corpus.id}] ${task.id}: ${arm} arm (rep ${rep}/${reps})...`);
          // A task graded by `mode: "test"` hands the agent Edit/Write, so its
          // cwd is about to be modified. The shared `cwd` above is either the
          // live registered checkout (kind=local) or a cache reused by every
          // other task in this run — writing into either would corrupt the rest
          // of the benchmark, and for kind=local, the user's actual working
          // tree. Same reason kungfu/gmesh-configured take a throwaway clone,
          // except this one can't be shared: each (task, arm, rep) needs the
          // corpus back in its unfixed state, so the clone is per run.
          //
          // A *-configured arm needs its CLAUDE.md in that per-run clone too,
          // which is why this branches on the arm rather than handing every
          // edit task a bare resolveFresh(). It used to short-circuit on
          // taskEditsCode() alone, so gmesh-configured silently ran with no
          // CLAUDE.md at all on exactly the category where the guidance
          // matters most — i.e. it was bare gmesh under another name. Note
          // these deliberately do NOT reuse the shared per-corpus
          // configuredCwd/kungfuConfiguredCwd below: those are for read-only
          // tasks, and an edit task must start from the unfixed corpus every
          // repetition.
          const armCwd = taskEditsCode(task)
            ? arm === "gmesh-configured"
              ? await (async () => {
                  // Unlike the shared configuredCwd above, this clone is
                  // fresh every single (task, rep) - never free after the
                  // first run, since every rep needs the corpus back in its
                  // unfixed state. Warming here pays a real g-mesh init walk
                  // every rep, front-loaded into setup instead of leaking
                  // into the measured call's turn count.
                  const dest = await resolveConfigured(corpus, GMESH_CONFIGURED_CLAUDE_MD);
                  console.log(`  [${task.id}] warming g-mesh index for this rep's edit sandbox...`);
                  await warmGmeshIndex(dest);
                  return dest;
                })()
              : arm === "kungfu-configured"
                ? await resolveConfigured(corpus, KUNGFU_CONFIGURED_CLAUDE_MD)
                : await resolveFresh(corpus)
            : arm === "kungfu" && kungfuCwd !== undefined
              ? kungfuCwd
              : arm === "gmesh-configured" && configuredCwd !== undefined
                ? configuredCwd
                : arm === "kungfu-configured" && kungfuConfiguredCwd !== undefined
                  ? kungfuConfiguredCwd
                  : cwd;
          // Logged (and left on disk) so a surprising verdict can be examined
          // afterwards — the agent's actual diff is the only real evidence of
          // what it did, and it lives nowhere else.
          if (taskEditsCode(task)) console.log(`  edit sandbox: ${armCwd}`);
          runs.push(await runArm(armCwd, task, corpus.id, arm, rep, timestamp));
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
