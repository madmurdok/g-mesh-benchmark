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

/**
 * A `seedFiles` destination and a `holdoutFiles` destination name the same
 * point in a run's lifecycle for opposite reasons — seeded so the agent can
 * see it, held out so it can't — so the same path can never be both without
 * one meaning silently winning. Checked once, here, rather than in every
 * consumer (testRunner.ts copies holdouts, token-economy.ts copies seeds),
 * because a tasks.json typo should fail loudly at load time, before any
 * clone or API call, not produce a run whose fixture setup is ambiguous.
 */
function validateSeedHoldoutDisjoint(task: BenchTask): void {
  const seedDests = new Set(Object.keys(task.seedFiles ?? {}));
  if (seedDests.size === 0) return;
  for (const dest of Object.keys(task.oracle.holdoutFiles ?? {})) {
    if (seedDests.has(dest)) {
      throw new Error(
        `task ${task.id}: "${dest}" is both a seedFiles and a holdoutFiles destination — a seed is copied in ` +
          `before the agent's turn, a holdout after it; the same path can't be both.`,
      );
    }
  }
}

export async function loadTasks(corpusId: string): Promise<BenchTask[]> {
  const tasksPath = path.join(ROOT, "corpora", corpusId, "tasks.json");
  if (!existsSync(tasksPath)) return [];
  const tasks: BenchTask[] = JSON.parse(await readFile(tasksPath, "utf8"));
  for (const task of tasks) validateSeedHoldoutDisjoint(task);
  return tasks;
}
