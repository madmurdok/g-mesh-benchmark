import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchTask, CorpusEntry } from "./types.js";

// This file lives under harness/lib/, one level deeper than token-economy.ts
// (harness/), so it needs an extra ".." to land on the same ROOT.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function loadRegistry(): Promise<CorpusEntry[]> {
  const raw = await readFile(path.join(ROOT, "corpora/registry.json"), "utf8");
  return JSON.parse(raw);
}

export async function loadTasks(corpusId: string): Promise<BenchTask[]> {
  const tasksPath = path.join(ROOT, "corpora", corpusId, "tasks.json");
  if (!existsSync(tasksPath)) return [];
  return JSON.parse(await readFile(tasksPath, "utf8"));
}
