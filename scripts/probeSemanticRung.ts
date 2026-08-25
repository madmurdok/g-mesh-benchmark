/**
 * Finds out *where* the semantic rung (g-mesh GM-234) actually fires, before
 * spending model tokens finding out whether it helps.
 *
 * The rung only runs on a total structural miss - no id, no qualifiedName, no
 * bare name, no file named after the query. So on a corpus where the ladder
 * already resolves everything, it is dead code and a benchmark comparison
 * would measure nothing but noise. That is worth knowing for free rather than
 * for a bench run's spend.
 *
 * Asks `find_definition` for every symbol the corpora's task oracles name, and
 * reports which rung answered. No model calls beyond the embedding query the
 * rung itself makes.
 *
 * Run: `G_MESH_BENCH_BINARY=... npx tsx scripts/probeSemanticRung.ts`
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWarm, warmGmeshIndex } from "../harness/lib/corpusResolver.js";
import { connectMcpClient } from "../harness/lib/mcpClient.js";
import { loadRegistry, loadTasks } from "../harness/lib/taskLoader.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
void ROOT;

function bodyOf(result: unknown): Record<string, unknown> | null {
  const text = (result as { content?: { text?: string }[] })?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A tool-level refusal is plain prose, not JSON - that is a "refused", not
    // a parse failure, and the caller distinguishes them by the null.
    return null;
  }
}

async function main(): Promise<void> {
  const registry = await loadRegistry();
  const byRung = new Map<string, string[]>();

  for (const entry of registry) {
    const cwd = await resolveWarm(entry);
    await warmGmeshIndex(cwd);
    const client = await connectMcpClient(cwd);
    try {
      const tasks = await loadTasks(entry.id);
      const seen = new Set<string>();
      for (const task of tasks) {
        for (const symbol of task.oracle.mustMentionSymbols ?? []) {
          if (seen.has(symbol)) continue;
          seen.add(symbol);
          const { result } = await client.call("find_definition", {
            symbol_name: symbol,
            include_source: false,
          });
          const body = bodyOf(result);
          const rung = body === null ? "REFUSED" : ((body.resolvedBy as string) ?? "(none)");
          const list = byRung.get(rung) ?? [];
          list.push(`${entry.id}:${symbol}`);
          byRung.set(rung, list);
        }
      }
    } finally {
      await client.close();
    }
  }

  console.log("\nWhich rung answered, over every symbol the oracles name:\n");
  for (const [rung, names] of [...byRung.entries()].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${rung.padEnd(20)} ${String(names.length).padStart(3)}`);
    if (rung === "semanticNeighbours" || rung === "REFUSED") {
      for (const n of names) console.log(`      ${n}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
