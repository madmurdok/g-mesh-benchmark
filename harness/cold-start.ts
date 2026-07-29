import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveFresh } from "./lib/corpusResolver.js";
import { connectMcpClient } from "./lib/mcpClient.js";
import { gmeshBinaryPath } from "./lib/mcpConfig.js";
import type { CorpusEntry } from "./lib/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTLINE_TOOL = "get_file_outline";
const INDEXABLE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
// Mirrors the skip-list g-mesh's own bulk-index walk uses (see g-mesh/README.md).
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".claude"]);

interface ColdStartRun {
  corpusId: string;
  timestamp: string;
  locCount: number;
  fileCount: number;
  cloneDurationMs: number;
  indexDurationMs: number;
  totalDurationMs: number;
}

interface CodeStats {
  locCount: number;
  fileCount: number;
  /** Project-relative path of one indexable file, used as the get_file_outline target. */
  sampleRelPath: string | null;
}

async function walkCodeStats(rootDir: string): Promise<CodeStats> {
  let locCount = 0;
  let fileCount = 0;
  let sampleRelPath: string | null = null;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (!INDEXABLE_EXTENSIONS.has(path.extname(entry.name))) continue;

      const abs = path.join(dir, entry.name);
      const content = await readFile(abs, "utf8");
      fileCount += 1;
      locCount += content.split("\n").length;
      if (sampleRelPath === null) {
        sampleRelPath = path.relative(rootDir, abs);
      }
    }
  }

  await walk(rootDir);
  return { locCount, fileCount, sampleRelPath };
}

async function loadRegistry(): Promise<CorpusEntry[]> {
  const raw = await readFile(path.join(ROOT, "corpora/registry.json"), "utf8");
  return JSON.parse(raw);
}

async function measureColdStart(corpus: CorpusEntry, timestamp: string): Promise<ColdStartRun | null> {
  const cloneStart = performance.now();
  const dir = await resolveFresh(corpus);
  const cloneDurationMs = performance.now() - cloneStart;

  try {
    const stats = await walkCodeStats(dir);
    if (!stats.sampleRelPath) {
      console.warn(`[${corpus.id}] no indexable files found in fresh checkout; skipping.`);
      return null;
    }

    // Timer starts right before spawning the shim and stops after the first
    // successful tool response, so it covers the cold-start cost regardless
    // of whether the indexing delay lands on connect() or on the first call
    // (g-mesh's daemon builds the initial index before accepting either).
    const indexStart = performance.now();
    const client = await connectMcpClient(dir);
    try {
      await client.call(OUTLINE_TOOL, { file_path: stats.sampleRelPath });
    } finally {
      await client.close();
    }
    const indexDurationMs = performance.now() - indexStart;

    return {
      corpusId: corpus.id,
      timestamp,
      locCount: stats.locCount,
      fileCount: stats.fileCount,
      cloneDurationMs,
      indexDurationMs,
      totalDurationMs: cloneDurationMs + indexDurationMs,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  const runs: ColdStartRun[] = [];

  for (const corpus of registry) {
    console.log(`[${corpus.id}] resolving fresh checkout + measuring cold start...`);
    try {
      const run = await measureColdStart(corpus, timestamp);
      if (run) {
        runs.push(run);
        console.log(
          `[${corpus.id}] indexDurationMs=${run.indexDurationMs.toFixed(0)} ` +
            `(${run.fileCount} files, ${run.locCount} LOC)`,
        );
      }
    } catch (err) {
      console.warn(`[${corpus.id}] cold-start measurement failed, skipping: ${(err as Error).message}`);
    }
  }

  const resultsDir = path.join(ROOT, "results/cold-start");
  await mkdir(resultsDir, { recursive: true });
  const outPath = path.join(resultsDir, `${timestamp.replace(/[:.]/g, "-")}.json`);
  await writeFile(outPath, JSON.stringify(runs, null, 2));
  console.log(`Wrote ${runs.length} run records to ${outPath}`);
}

main();
