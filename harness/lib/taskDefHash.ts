import { createHash } from "node:crypto";
import type { BenchTask } from "./types.js";

/**
 * Recursively normalizes a value so object key order never affects the
 * resulting JSON string, while array order (which is semantically
 * meaningful, e.g. `steps[]`) is preserved untouched. Generic on purpose —
 * BenchTask.target is a union (`TaskTarget | { steps: TaskTarget[] }`), and
 * this must handle both shapes (and any future field) without special-casing
 * either.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Fingerprints a task's full definition (prompt, oracle, target, everything)
 * so a report can tell whether a historical run was graded against the task
 * definition as it exists today, or a since-edited version of it. Stable
 * across `tasks.json` field reordering (object keys are sorted before
 * stringifying) but sensitive to any actual content change.
 */
export function computeTaskDefHash(task: BenchTask): string {
  const stable = JSON.stringify(sortKeysDeep(task));
  return createHash("sha256").update(stable).digest("hex").slice(0, 12);
}
