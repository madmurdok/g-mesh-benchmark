import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { resolveWarm } from "./lib/corpusResolver.js";
import { buildBaselineArmConfig, buildGmeshArmConfig, gmeshBinaryPath } from "./lib/mcpConfig.js";
import { checkOracle } from "./lib/oracleCheck.js";
import { runClaude } from "./lib/runClaude.js";
import type { BenchTask, CorpusEntry } from "./lib/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "claude-sonnet-5";
const MAX_BUDGET_USD = 1.0;
const GMESH_TOOLS = "Read,Grep,Glob,mcp__g-mesh__*";
const BASELINE_TOOLS = "Read,Grep,Glob";

type Arm = "gmesh" | "baseline";

interface TokenEconomyRun {
  taskId: string;
  corpusId: string;
  arm: Arm;
  repetition: number;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  durationMs: number;
  costUsd: number;
  resultText: string;
  oraclePassed: boolean;
  status: "ok" | "error" | "budget_exceeded";
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

async function loadRegistry(): Promise<CorpusEntry[]> {
  const raw = await readFile(path.join(ROOT, "corpora/registry.json"), "utf8");
  return JSON.parse(raw);
}

async function loadTasks(corpusId: string): Promise<BenchTask[]> {
  const tasksPath = path.join(ROOT, "corpora", corpusId, "tasks.json");
  if (!existsSync(tasksPath)) return [];
  return JSON.parse(await readFile(tasksPath, "utf8"));
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
    prompt: task.prompt,
    mcpConfig: arm === "gmesh" ? buildGmeshArmConfig() : buildBaselineArmConfig(),
    tools: arm === "gmesh" ? GMESH_TOOLS : BASELINE_TOOLS,
    model: MODEL,
    maxBudgetUsd: MAX_BUDGET_USD,
  });
  const oracle = checkOracle(result.resultText, task.oracle);
  return {
    taskId: task.id,
    corpusId,
    arm,
    repetition,
    timestamp,
    model: MODEL,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
    numTurns: result.numTurns,
    durationMs: result.durationMs,
    costUsd: result.costUsd,
    resultText: result.resultText,
    oraclePassed: oracle.passed,
    status: result.status,
  };
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
    mcpConfig: arm === "gmesh" ? buildGmeshArmConfig() : buildBaselineArmConfig(),
    tools: arm === "gmesh" ? GMESH_TOOLS : BASELINE_TOOLS,
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

async function warmCache(cwd: string): Promise<void> {
  console.log("Warming prompt cache: gmesh arm...");
  await warmArm(cwd, "gmesh");
  console.log("Warming prompt cache: baseline arm...");
  await warmArm(cwd, "baseline");
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
    await warmCache(warmupCwd);
  }

  const reps = repetitionCount();
  console.log(`Repetitions per (task, arm): ${reps}`);

  for (const corpus of registry) {
    const corpusTasks = tasksByCorpus.get(corpus.id) ?? [];
    const tasks =
      selectedTaskIds.length > 0 ? corpusTasks.filter((t) => selectedTaskIds.includes(t.id)) : corpusTasks;
    if (tasks.length === 0) continue;
    const cwd = await resolveWarm(corpus);

    for (const task of tasks) {
      for (let rep = 1; rep <= reps; rep++) {
        console.log(`[${corpus.id}] ${task.id}: gmesh arm (rep ${rep}/${reps})...`);
        runs.push(await runArm(cwd, task, corpus.id, "gmesh", rep, timestamp));
        console.log(`[${corpus.id}] ${task.id}: baseline arm (rep ${rep}/${reps})...`);
        runs.push(await runArm(cwd, task, corpus.id, "baseline", rep, timestamp));
      }
    }
  }

  const resultsDir = path.join(ROOT, "results/token-economy");
  await mkdir(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${timestamp.replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify(runs, null, 2));
  console.log(`Wrote ${runs.length} run records to ${outPath}`);
}

main();
