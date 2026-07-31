import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_BUDGET_USD, MODEL, armMcpConfig, armPrompt, armTools } from "./lib/armConfig.js";
import { resolveFresh, resolveWarm } from "./lib/corpusResolver.js";
import { gmeshBinaryPath, kungfuBinaryPath } from "./lib/mcpConfig.js";
import { checkOracle } from "./lib/oracleCheck.js";
import { runClaude } from "./lib/runClaude.js";
import { renderSessionHtmlReport } from "./lib/sessionReport.js";
import { computeTaskDefHash } from "./lib/taskDefHash.js";
import { loadRegistry, loadTasks } from "./lib/taskLoader.js";
import type { Arm, BenchTask } from "./lib/types.js";
import {
  MAX_COMBINED_BUDGET_USD,
  combinedBudgetStatus,
  type RunStatus,
  type TokenEconomyRun,
} from "./token-economy.js";

/**
 * session-economy — the same gmesh-vs-baseline comparison as token-economy,
 * measured under a *continuing* session instead of a fresh process per task.
 *
 * token-economy runs every (task, arm, repetition) as an isolated `claude -p`
 * process, so each one re-pays g-mesh's MCP tool-schema cost from cold via
 * cache_creation_input_tokens. That is the worst case for g-mesh and not what
 * real Claude Code usage looks like — a real session is one long conversation
 * asking many questions against the same registered tools. This experiment
 * chains one corpus's whole task list into a single session per arm (via
 * runClaude's resumeSessionId / `--resume`) and records each task's own cost,
 * so the cold-start-then-amortize curve is directly observable.
 *
 * Deliberately no cache warm-up knob (unlike token-economy's
 * G_MESH_BENCH_WARM_CACHE): pre-warming would hide exactly the curve this
 * experiment exists to measure.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One task's measurement inside a chained session.
 *
 * Extends TokenEconomyRun rather than defining a parallel shape so every pure
 * aggregator in lib/reportData.ts (tokensSpent, armsPresent,
 * computeCorrectnessTable, loadRuns<T>) works on these records unmodified —
 * the same structural-extension precedent report.ts already relies on.
 */
export interface SessionEconomyRun extends TokenEconomyRun {
  /** 1-based position of this task within its chain — the x-axis of the amortization curve. */
  sequenceIndex: number;
  /** How many tasks this chain covers in total (i.e. the corpus's task count). */
  sessionLength: number;
  /** The CLI session_id in effect after this call; absent on skipped tasks (no call was made). */
  claudeSessionId?: string;
}

/**
 * Spend ceiling for one whole chain: the per-call combined ceiling times the
 * number of calls the chain will make.
 *
 * Deliberately as loose as "every call was allowed to hit its own cap" rather
 * than something tighter — same reasoning as MAX_COMBINED_BUDGET_USD itself.
 * Crossing it means a per-call cap was overshot or a call was made this
 * accounting doesn't know about, not that the chain was legitimately
 * expensive, which makes it an invariant rather than a second throttle.
 *
 * Pure and exported so the abort path is testable without spending real API
 * money (see harness/session-economy.test.ts).
 */
export function sessionBudgetCeiling(taskCount: number, perCallCeilingUsd: number): number {
  return taskCount * perCallCeilingUsd;
}

/**
 * Whether a chain's spend so far is still inside its ceiling. Strict >:
 * landing exactly on the ceiling is still within budget, matching
 * combinedBudgetStatus's existing boundary convention.
 */
export function sessionBudgetStatus(cumulativeCostUsd: number, ceilingUsd: number): "ok" | "exceeded" {
  return cumulativeCostUsd > ceilingUsd ? "exceeded" : "ok";
}

const SESSION_REPETITION_PRESETS = { low: 1, normal: 2, max: 3 } as const;
type SessionRepetitionMode = keyof typeof SESSION_REPETITION_PRESETS;

/**
 * G_MESH_BENCH_SESSION_REPS selects how many *independent, fresh* chains are
 * run per (corpus, arm) so a chain's numbers can be averaged over more than
 * one session.
 *
 * Deliberately a separate env var from token-economy's G_MESH_BENCH_REPS, not
 * a shared one: repeating a task inside the same session is not the same
 * measurement as repeating an isolated call, and each repetition here costs a
 * whole chain (5 or 15 calls per arm), so silently inheriting a preset chosen
 * for the cheaper experiment would multiply this one's spend unexpectedly.
 * Presets are correspondingly smaller: 1/2/3.
 */
function sessionRepetitionCount(): number {
  const raw = process.env.G_MESH_BENCH_SESSION_REPS ?? "normal";
  const normalized = raw.trim().toLowerCase();
  if (normalized in SESSION_REPETITION_PRESETS) {
    return SESSION_REPETITION_PRESETS[normalized as SessionRepetitionMode];
  }
  throw new Error(`Invalid G_MESH_BENCH_SESSION_REPS value "${raw}"; expected "low", "normal", or "max".`);
}

/**
 * G_MESH_BENCH_INCLUDE_TRUSTED=yes|no gates the third `gmesh-trusted` arm.
 *
 * Default no. Set to yes to also chain a gmesh-trusted session per (corpus,
 * repetition), which adds a whole third chain — ~1.5x the API spend of the
 * usual two-arm run. Duplicated verbatim from token-economy.ts's gate rather
 * than shared: the two experiments read the same variable but are free to
 * diverge on what it costs them, and this codebase already duplicates its
 * small per-entrypoint env gates on purpose.
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
 * arm — same opt-in pattern as shouldIncludeTrustedArm(), duplicated
 * verbatim from token-economy.ts's gate (task #57) for the same reason that
 * gate itself is duplicated here rather than shared.
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
 * kungfuBinaryPath() defaults to the bare command "kungfu", resolved via
 * PATH at spawn time — existsSync can't check that directly. Duplicated from
 * token-economy.ts's identical helper (kungfuBinaryIsAvailable).
 */
function kungfuBinaryIsAvailable(): boolean {
  const bin = kungfuBinaryPath();
  if (bin.includes(path.sep)) return existsSync(bin);
  return (process.env.PATH ?? "").split(path.delimiter).some((dir) => dir.length > 0 && existsSync(path.join(dir, bin)));
}

/**
 * Extra CLI args (`npm run session-economy -- task-tracker-mcp`) select whole
 * corpora, never individual tasks: a chain's premise is "one realistic session
 * over this codebase's whole question list", and an arbitrary task subset
 * would silently change what a sequence position means. Empty argv runs every
 * corpus in the registry.
 */
function requestedCorpusIds(): string[] {
  return process.argv.slice(2);
}

/** A task that never ran, recorded explicitly so the run set shows *why* a measurement is missing. */
function skippedRun(
  task: BenchTask,
  corpusId: string,
  arm: Arm,
  repetition: number,
  timestamp: string,
  sequenceIndex: number,
  sessionLength: number,
): SessionEconomyRun {
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
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    numTurns: 0,
    durationMs: 0,
    costUsd: 0,
    judgeCostUsd: 0,
    resultText: "",
    oraclePassed: false,
    status: "skipped",
    sequenceIndex,
    sessionLength,
  };
}

/**
 * One chained session: every task of one corpus, in registry order, asked in
 * a single conversation for a single arm.
 *
 * The session is threaded by handing each call's returned sessionId to the
 * next call as resumeSessionId. Everything else (MCP config, tool list, model,
 * per-call budget) is re-passed identically every time — each `claude -p` is a
 * fresh process and inherits none of it from the session it resumes.
 *
 * The chain aborts (marking every remaining task "skipped") on any non-ok
 * status, on a per-chain budget overrun, and — importantly — on a *missing*
 * sessionId after an otherwise-ok call. That last case is a broken invariant:
 * continuing would quietly start an unrelated fresh session on the next call,
 * so every later measurement would be a cold start mislabelled as a
 * mid-session one, with nothing in the output to show it.
 */
async function runSessionChain(
  cwd: string,
  tasks: BenchTask[],
  corpusId: string,
  arm: Arm,
  sessionRepetition: number,
  timestamp: string,
): Promise<SessionEconomyRun[]> {
  const sessionLength = tasks.length;
  const ceilingUsd = sessionBudgetCeiling(sessionLength, MAX_COMBINED_BUDGET_USD);
  const runs: SessionEconomyRun[] = [];

  let cumulativeCostUsd = 0;
  let resumeSessionId: string | undefined;
  let abortReason: string | null = null;

  for (const [index, task] of tasks.entries()) {
    const sequenceIndex = index + 1;

    if (abortReason !== null) {
      runs.push(skippedRun(task, corpusId, arm, sessionRepetition, timestamp, sequenceIndex, sessionLength));
      continue;
    }

    if (sessionBudgetStatus(cumulativeCostUsd, ceilingUsd) === "exceeded") {
      abortReason =
        `chain spend $${cumulativeCostUsd.toFixed(4)} exceeded its ceiling $${ceilingUsd.toFixed(4)}`;
      console.warn(`  ! [${corpusId}] ${arm} chain (rep ${sessionRepetition}): ${abortReason}; skipping the rest.`);
      runs.push(skippedRun(task, corpusId, arm, sessionRepetition, timestamp, sequenceIndex, sessionLength));
      continue;
    }

    console.log(`  [${corpusId}] ${arm} rep ${sessionRepetition}: ${sequenceIndex}/${sessionLength} ${task.id}...`);
    const result = await runClaude({
      cwd,
      prompt: armPrompt(task.prompt, arm),
      mcpConfig: armMcpConfig(arm),
      tools: armTools(arm),
      model: MODEL,
      maxBudgetUsd: MAX_BUDGET_USD,
      resumeSessionId,
    });

    // Same prospective half of the combined budget bound as token-economy's
    // runArm: grading a failed run is pointless and, in judge mode, not free.
    const oracle = result.status === "ok" ? await checkOracle(result.resultText, task.oracle) : undefined;
    const judgeCostUsd = oracle?.judgeCostUsd ?? 0;
    const status: RunStatus = combinedBudgetStatus(result.status, result.costUsd, judgeCostUsd);
    if (status === "budget_exceeded" && result.status === "ok") {
      console.warn(
        `  ! ${task.id} (${arm}, rep ${sessionRepetition}): arm $${result.costUsd.toFixed(4)} + judge ` +
          `$${judgeCostUsd.toFixed(4)} exceeds the combined ceiling $${MAX_COMBINED_BUDGET_USD.toFixed(4)}; ` +
          `recording this run as budget_exceeded.`,
      );
    }

    cumulativeCostUsd += result.costUsd + judgeCostUsd;
    if (result.sessionId !== undefined) resumeSessionId = result.sessionId;

    runs.push({
      taskId: task.id,
      corpusId,
      arm,
      repetition: sessionRepetition,
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
      sequenceIndex,
      sessionLength,
      claudeSessionId: result.sessionId,
    });

    if (status !== "ok") {
      abortReason = `call ${sequenceIndex} finished with status "${status}"`;
    } else if (result.sessionId === undefined) {
      abortReason = `call ${sequenceIndex} returned no session_id, so the session cannot be continued`;
    }
    if (abortReason !== null) {
      console.warn(`  ! [${corpusId}] ${arm} chain (rep ${sessionRepetition}): ${abortReason}; skipping the rest.`);
    }
  }

  return runs;
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

  const selectedCorpusIds = requestedCorpusIds();
  if (selectedCorpusIds.length > 0) {
    const knownIds = new Set(registry.map((c) => c.id));
    const unknown = selectedCorpusIds.filter((id) => !knownIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown corpus id(s): ${unknown.join(", ")}. Known: ${[...knownIds].join(", ")}.`);
    }
  }
  const corpora = selectedCorpusIds.length > 0 ? registry.filter((c) => selectedCorpusIds.includes(c.id)) : registry;

  const reps = sessionRepetitionCount();
  const arms: Arm[] = ["gmesh", "baseline"];
  if (shouldIncludeTrustedArm()) arms.push("gmesh-trusted");
  if (includeKungfu) arms.push("kungfu");
  console.log(
    `Chains per (corpus, arm): ${reps} | arms: ${arms.join(", ")} | corpora: ${corpora.map((c) => c.id).join(", ")}`,
  );
  if (arms.length > 2) {
    console.log(
      `Extra arms beyond gmesh/baseline are each a whole extra chain per (corpus, repetition): ` +
        `expect roughly ${(arms.length / 2).toFixed(1)}x the API spend of a two-arm run.`,
    );
  }

  const runs: SessionEconomyRun[] = [];

  // Sequential on purpose, no parallelism: two chains sharing one resolveWarm()
  // checkout concurrently is untested, and overlapping sessions would blur the
  // very cache behavior being measured.
  for (const corpus of corpora) {
    const tasks = await loadTasks(corpus.id);
    if (tasks.length === 0) {
      console.log(`[${corpus.id}] no tasks defined; skipping.`);
      continue;
    }
    const cwd = await resolveWarm(corpus);
    // Same reasoning as token-economy.ts's #57 fix: kungfu writes a .kungfu/
    // index into its cwd, so its chain must run against a throwaway clone,
    // never the shared `cwd` above (the live, registry-registered checkout).
    // One clone per corpus, reused across every repetition's kungfu chain.
    const kungfuCwd = arms.includes("kungfu") ? await resolveFresh(corpus) : undefined;
    for (let rep = 1; rep <= reps; rep++) {
      for (const arm of arms) {
        console.log(`[${corpus.id}] ${arm} session (chain ${rep}/${reps}, ${tasks.length} tasks)...`);
        const armCwd = arm === "kungfu" && kungfuCwd !== undefined ? kungfuCwd : cwd;
        runs.push(...(await runSessionChain(armCwd, tasks, corpus.id, arm, rep, timestamp)));
      }
    }
  }

  const fileStamp = timestamp.replace(/[:.]/g, "-");

  const resultsDir = path.join(ROOT, "results/session-economy");
  await mkdir(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${fileStamp}.json`);
  await writeFile(outPath, JSON.stringify(runs, null, 2));
  console.log(`Wrote ${runs.length} run records to ${outPath}`);

  // Same "own line item, never summed into the comparison" discipline as
  // token-economy: arm spend and grading spend stay separate. Narrative spend
  // is always 0 here — this experiment deliberately does not generate one,
  // because generateNarrative() is written against computeAggregate(), whose
  // headline math assumes every run is an isolated measurement.
  const armSpend = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const judgeSpend = runs.reduce((sum, r) => sum + r.judgeCostUsd, 0);

  const html = renderSessionHtmlReport(runs, { title: "g-mesh-bench session-economy run", narrative: null });
  const htmlDir = path.join(ROOT, "results/html");
  await mkdir(htmlDir, { recursive: true });
  const htmlPath = path.join(htmlDir, `session-${fileStamp}.html`);
  await writeFile(htmlPath, html);
  console.log(`Wrote HTML report to ${htmlPath}`);

  console.log(
    `Arm spend: $${armSpend.toFixed(4)} | judge (grading) spend: $${judgeSpend.toFixed(4)} | ` +
      `narrative spend: $0.0000 (not generated for this experiment)`,
  );
  const skipped = runs.filter((r) => r.status === "skipped").length;
  const overBudget = runs.filter((r) => r.status === "budget_exceeded").length;
  const errored = runs.filter((r) => r.status === "error").length;
  console.log(`Runs — ok: ${runs.filter((r) => r.status === "ok").length}, skipped: ${skipped}, error: ${errored}, budget_exceeded: ${overBudget}`);
}

/**
 * Only auto-run when this file is the process entry point, so the module can
 * be imported (harness/session-economy.test.ts imports the budget helpers)
 * without kicking off a real, API-spending benchmark. `npm run session-economy`
 * is unaffected: tsx sets argv[1] to this file's path.
 */
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
