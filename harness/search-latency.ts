import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveWarm } from "./lib/corpusResolver.js";
import { connectMcpClient } from "./lib/mcpClient.js";
import { gmeshBinaryPath } from "./lib/mcpConfig.js";
import { loadRegistry, loadTasks } from "./lib/taskLoader.js";
import type { BenchTask, CorpusEntry, TaskTarget } from "./lib/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The 7 g-mesh MCP tools this experiment measures, in a fixed order so
 * console output and the written records are always in the same order.
 */
const TOOL_NAMES = [
  "find_definition",
  "find_references",
  "find_callers",
  "find_callees",
  "find_implementations",
  "get_file_outline",
  "get_dependencies",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

/**
 * find_definition/find_references/find_callers/find_callees/find_implementations
 * all resolve their target the same way: by `symbol_name` (see g-mesh's
 * `FindDefinitionParams`/`SymbolQueryParams` — the server's own tool
 * instructions say to pass `symbol_name` directly rather than resolving a
 * `symbol_id` via find_definition first). That shared shape is what lets
 * buildToolTargets() below treat any one of them as a fallback target for
 * any other.
 */
const SYMBOL_TOOLS = new Set<ToolName>([
  "find_definition",
  "find_references",
  "find_callers",
  "find_callees",
  "find_implementations",
]);

/**
 * How many times each tool is called per corpus. G_MESH_BENCH_SEARCH_SAMPLES
 * overrides the default of 20 for a quick smoke run.
 */
function sampleCount(): number {
  const raw = process.env.G_MESH_BENCH_SEARCH_SAMPLES;
  if (raw === undefined) return 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid G_MESH_BENCH_SEARCH_SAMPLES value "${raw}"; expected a positive integer.`);
  }
  return n;
}

/**
 * Matches the design doc's SEARCH_LATENCY_RUN entity (docs/architecture/g-mesh-bench-v1.md,
 * Data Model) field-for-field, plus two additions the doc doesn't mention:
 * `target` (kept for auditability — which symbol/file each toolName's
 * samples were measured against) and `meanMs` (the task description asks for
 * mean alongside p50/p95, which the doc's ERD omits).
 */
export interface SearchLatencyRun {
  corpusId: string;
  toolName: ToolName;
  timestamp: string;
  target: TaskTarget;
  samplesMs: number[];
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  errorCount: number;
}

/** Nearest-rank percentile over an ascending-sorted array; 0 for an empty array (all calls errored). */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)] ?? 0;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function isSingleHopTarget(task: BenchTask): TaskTarget | undefined {
  return "symbol" in task.target ? task.target : undefined;
}

/**
 * Picks one known-good {symbol,file} target per tool type out of a corpus's
 * own tasks.json, rather than inventing new fixtures: every target here is
 * one this suite has already asserted g-mesh resolves correctly elsewhere.
 *
 * Not every corpus has a task of every kind (e.g. task-tracker-mcp/tasks.json
 * has no find_definition/find_callers/find_callees task). For the 5
 * symbol-addressed tools (see SYMBOL_TOOLS above), any one of them resolving
 * a symbol by name is a valid stand-in for another, so a missing kind falls
 * back to whichever symbol-kind task the corpus does have — preferring
 * find_references as the most "plain lookup" of the five.
 *
 * get_file_outline/get_dependencies take file-shaped args instead, so they
 * have no such fallback: a corpus missing that kind's task just skips that
 * tool (logged by the caller).
 */
function buildToolTargets(tasks: BenchTask[]): Partial<Record<ToolName, TaskTarget>> {
  const byKind = new Map<string, TaskTarget>();
  for (const task of tasks) {
    const target = isSingleHopTarget(task);
    // First match wins on purpose: corpora/excalidraw/tasks.json deliberately
    // includes later find_references tasks with ambiguous symbol names (see
    // its "ambiguous-name" category) — those are what report.ts/oracles use
    // to test ambiguity handling, not what a latency measurement wants.
    if (target && !byKind.has(task.kind)) byKind.set(task.kind, target);
  }

  const symbolFallback =
    byKind.get("find_references") ??
    byKind.get("find_definition") ??
    byKind.get("find_implementations") ??
    byKind.get("find_callers") ??
    byKind.get("find_callees");

  const targets: Partial<Record<ToolName, TaskTarget>> = {};
  for (const tool of SYMBOL_TOOLS) {
    targets[tool] = byKind.get(tool) ?? symbolFallback;
  }
  targets.get_file_outline = byKind.get("get_file_outline");
  targets.get_dependencies = byKind.get("get_dependencies");
  return targets;
}

/**
 * get_dependencies needs a direction the shared TaskTarget shape doesn't
 * carry. Every existing get_dependencies task in both corpora is an
 * "incoming" query (see their task ids), so that's the default; a future
 * corpus can opt into "outgoing" by naming its get_dependencies task id with
 * "outgoing" in it, matching the existing "incoming" naming convention.
 */
function dependenciesDirection(tasks: BenchTask[]): "Incoming" | "Outgoing" {
  const task = tasks.find((t) => t.kind === "get_dependencies");
  return task?.id.toLowerCase().includes("outgoing") ? "Outgoing" : "Incoming";
}

function buildArgs(tool: ToolName, target: TaskTarget, direction: "Incoming" | "Outgoing"): Record<string, unknown> {
  if (tool === "get_file_outline") return { file_path: target.file };
  if (tool === "get_dependencies") return { file_path: target.file, direction };
  return { symbol_name: target.symbol };
}

async function measureCorpus(
  corpus: CorpusEntry,
  tasks: BenchTask[],
  timestamp: string,
  samples: number,
): Promise<SearchLatencyRun[]> {
  const targets = buildToolTargets(tasks);
  const direction = dependenciesDirection(tasks);
  const cwd = await resolveWarm(corpus);
  const client = await connectMcpClient(cwd);
  const runs: SearchLatencyRun[] = [];

  try {
    // One throwaway call so a cold per-project index build (or just the
    // first MCP round-trip) doesn't leak into the first tool's measured
    // samples below — this experiment measures warm-index latency only,
    // cold-start.ts owns the indexing-time metric.
    const warmupTool = targets.get_file_outline ? "get_file_outline" : "find_references";
    const warmupTarget = targets.get_file_outline ?? targets.find_references;
    if (warmupTarget) {
      try {
        await client.call(warmupTool, buildArgs(warmupTool, warmupTarget, direction));
      } catch (err) {
        console.warn(`[${corpus.id}] warm-up call failed (continuing anyway): ${(err as Error).message}`);
      }
    }

    for (const tool of TOOL_NAMES) {
      const target = targets[tool];
      if (!target) {
        console.warn(`[${corpus.id}] no known-good target for ${tool}; skipping.`);
        continue;
      }

      const args = buildArgs(tool, target, direction);
      const samplesMs: number[] = [];
      let errorCount = 0;
      for (let i = 0; i < samples; i++) {
        try {
          const { elapsedMs } = await client.call(tool, args);
          samplesMs.push(elapsedMs);
        } catch (err) {
          errorCount += 1;
          console.warn(`[${corpus.id}] ${tool} call ${i + 1}/${samples} failed: ${(err as Error).message}`);
        }
      }

      const sorted = [...samplesMs].sort((a, b) => a - b);
      const run: SearchLatencyRun = {
        corpusId: corpus.id,
        toolName: tool,
        timestamp,
        target,
        samplesMs,
        p50Ms: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        meanMs: mean(samplesMs),
        errorCount,
      };
      runs.push(run);
      console.log(
        `[${corpus.id}] ${tool}: p50=${run.p50Ms.toFixed(1)}ms p95=${run.p95Ms.toFixed(1)}ms ` +
          `mean=${run.meanMs.toFixed(1)}ms (${samplesMs.length}/${samples} ok)`,
      );
    }
  } finally {
    await client.close();
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

  const timestamp = new Date().toISOString();
  const registry = await loadRegistry();
  const samples = sampleCount();
  console.log(`Samples per tool: ${samples}`);

  const runs: SearchLatencyRun[] = [];
  for (const corpus of registry) {
    const tasks = await loadTasks(corpus.id);
    if (tasks.length === 0) {
      console.warn(`[${corpus.id}] no tasks.json entries; skipping.`);
      continue;
    }
    console.log(`[${corpus.id}] measuring search latency...`);
    try {
      runs.push(...(await measureCorpus(corpus, tasks, timestamp, samples)));
    } catch (err) {
      console.warn(`[${corpus.id}] search-latency measurement failed, skipping: ${(err as Error).message}`);
    }
  }

  const resultsDir = path.join(ROOT, "results/search-latency");
  await mkdir(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${timestamp.replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify(runs, null, 2));
  console.log(`Wrote ${runs.length} run records to ${outPath}`);
}

main();
