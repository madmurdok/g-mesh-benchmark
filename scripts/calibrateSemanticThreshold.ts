/**
 * Measures what `search_code` scores look like when it is right and when it is
 * wrong, so the semantic rung of g-mesh's resolution ladder (GM-234) can be
 * given a cutoff that was measured rather than eyeballed.
 *
 * # Why this exists
 *
 * The whole signal available before this was three hand-run queries: 0.61 for a
 * right answer, 0.468 and 0.431 for junk. A cutoff drawn between 0.47 and 0.61
 * on three points would be a guess wearing a number's clothes. Below the line a
 * rung that never fires is merely useless; above it, a refusal turns into
 * confident nonsense - and this codebase's standing rule is that a missing edge
 * beats a wrong one.
 *
 * # What it measures
 *
 * Two distributions, over both corpora:
 *
 * - **Right answers.** Every `mustMentionSymbols` entry from the corpora's own
 *   task oracles. These are not invented for the occasion and cannot be tuned
 *   to flatter the result - they are the names the benchmark already asserts an
 *   agent has to find. For each, the score of the *correct* hit (matched by
 *   name, or by the file the oracle names), not merely of the top hit: a rung
 *   that surfaces the right answer third is still useful, and scoring only the
 *   top hit would confuse "ranked badly" with "scored low".
 * - **No right answer.** Package specifiers, paths, invented identifiers, and -
 *   the sharpest of the four - symbols drawn from the *other* corpus, which are
 *   real names that genuinely are not in this index. For each, the top hit's
 *   score, since anything returned at all is a false positive.
 *
 * No model calls: `search_code` runs against an index that is already built, so
 * this costs wall-clock and no API spend.
 *
 * Run: `npx tsx scripts/calibrateSemanticThreshold.ts`
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveWarm, warmGmeshIndex } from "../harness/lib/corpusResolver.js";
import { connectMcpClient } from "../harness/lib/mcpClient.js";
import { loadRegistry, loadTasks } from "../harness/lib/taskLoader.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** How many hits to ask for. Wide enough that a correct-but-not-top hit is
 *  still observed, narrow enough that the response stays small. */
const LIMIT = 10;

interface Hit {
  qualifiedName?: string;
  filePath?: string;
  score?: number;
}

interface RightAnswer {
  corpus: string;
  query: string;
  /** Score of the first hit that matches the oracle, if any. */
  correctScore: number | null;
  /** Where in the ranking that hit was: 1 = top. */
  correctRank: number | null;
  topScore: number | null;
}

interface NoAnswer {
  corpus: string;
  query: string;
  kind: "package" | "path" | "invented" | "other-corpus-symbol";
  topScore: number | null;
  topHit: string | null;
}

function hitsOf(result: unknown): Hit[] {
  const text = (result as { content?: { text?: string }[] })?.content?.[0]?.text;
  if (typeof text !== "string") return [];
  try {
    const body = JSON.parse(text) as { results?: Hit[] };
    return body.results ?? [];
  } catch {
    return [];
  }
}

/**
 * Whether `hit` is the answer the oracle was asking for.
 *
 * Deliberately generous on identity and strict about nothing else: a match on
 * the symbol name, or on a file the oracle names, both count. The rung being
 * calibrated presents candidates for a human or an agent to pick from, so "the
 * right file came back" is a hit for its purposes even when the symbol inside
 * it is named differently - which is exactly the `DropdownMenuGroup` ->
 * `MenuGroup` case that motivated the whole feature.
 */
function isCorrect(hit: Hit, symbol: string, files: string[]): boolean {
  const qualified = hit.qualifiedName ?? "";
  // `search_code` returns no bare `name`, only `qualifiedName`, which for the
  // TypeScript plugin is sometimes the identifier alone and sometimes a
  // qualified path. Comparing the last identifier segment covers both without
  // guessing at the separator.
  // *Any* segment, not just the last. `AppStateDelta#inverse` is a method of
  // the queried type and a correct hit for it; taking only the trailing
  // segment saw `inverse` and scored a 0.831 hit as a miss on the first run.
  // Matching whole segments keeps it strict where it matters - `createAppState`
  // is one segment and still does not match `AppState`.
  const segments = qualified.split(/[^A-Za-z0-9_$]+/).filter(Boolean);
  if (qualified === symbol || segments.includes(symbol)) return true;
  const file = hit.filePath ?? "";
  return files.some((f) => f.length > 0 && file === f);
}

async function main(): Promise<void> {
  const registry = await loadRegistry();
  const right: RightAnswer[] = [];
  const none: NoAnswer[] = [];

  // Collected first so each corpus can be probed with the *other* one's
  // symbols - the most honest negative available, since they are real
  // identifiers that simply do not live in this index.
  const symbolsByCorpus = new Map<string, string[]>();
  for (const entry of registry) {
    const tasks = await loadTasks(entry.id);
    const symbols = new Set<string>();
    for (const task of tasks) for (const s of task.oracle.mustMentionSymbols ?? []) symbols.add(s);
    symbolsByCorpus.set(entry.id, [...symbols]);
  }

  for (const entry of registry) {
    const cwd = await resolveWarm(entry);
    console.log(`\n[${entry.id}] ${cwd}`);
    // Blocking, and the reason is a mistake this script made on its first run:
    // querying immediately after the shim bootstraps a daemon measures a
    // half-built index. Every excalidraw query came back with no correct hit,
    // which reads exactly like "semantic search is useless" and was in fact
    // "the walk had not finished". `g-mesh init` returns only once it has.
    await warmGmeshIndex(cwd);
    const client = await connectMcpClient(cwd);

    try {
      const tasks = await loadTasks(entry.id);

      // --- right answers, from the oracles ------------------------------
      const seen = new Set<string>();
      for (const task of tasks) {
        const files = task.oracle.mustMentionFiles ?? [];
        for (const symbol of task.oracle.mustMentionSymbols ?? []) {
          if (seen.has(symbol)) continue;
          seen.add(symbol);
          const { result } = await client.call("search_code", { query: symbol, limit: LIMIT });
          const hits = hitsOf(result);
          const idx = hits.findIndex((h) => isCorrect(h, symbol, files));
          right.push({
            corpus: entry.id,
            query: symbol,
            correctScore: idx >= 0 ? (hits[idx]?.score ?? null) : null,
            correctRank: idx >= 0 ? idx + 1 : null,
            topScore: hits[0]?.score ?? null,
          });
          process.stdout.write(idx === 0 ? "." : idx > 0 ? "o" : "x");
        }
      }

      // --- queries with no right answer ---------------------------------
      const others = [...symbolsByCorpus.entries()]
        .filter(([id]) => id !== entry.id)
        .flatMap(([, s]) => s)
        .slice(0, 25);

      const negatives: { query: string; kind: NoAnswer["kind"] }[] = [
        ...NEGATIVE_PACKAGES.map((q) => ({ query: q, kind: "package" as const })),
        ...NEGATIVE_PATHS.map((q) => ({ query: q, kind: "path" as const })),
        ...NEGATIVE_INVENTED.map((q) => ({ query: q, kind: "invented" as const })),
        ...others.map((q) => ({ query: q, kind: "other-corpus-symbol" as const })),
      ];

      for (const { query, kind } of negatives) {
        const { result } = await client.call("search_code", { query, limit: LIMIT });
        const hits = hitsOf(result);
        none.push({
          corpus: entry.id,
          query,
          kind,
          topScore: hits[0]?.score ?? null,
          topHit: hits[0]?.qualifiedName ?? null,
        });
        process.stdout.write("-");
      }
    } finally {
      await client.close();
    }
  }

  const out = path.join(ROOT, "results", "semantic-threshold-calibration.json");
  await writeFile(out, `${JSON.stringify({ right, none, limit: LIMIT }, null, 2)}\n`);
  console.log(`\n\nWrote ${right.length} right-answer and ${none.length} no-answer samples to ${out}`);
  report(right, none);
}

/**
 * Package specifiers - the case checked by hand and found to score 0.468 on
 * junk. Only declarations' doc comments and signatures are embedded, so a
 * package name has nothing to match and whatever comes back is noise.
 */
const NEGATIVE_PACKAGES = [
  "@excalidraw/math",
  "@excalidraw/element",
  "@modelcontextprotocol/sdk",
  "better-sqlite3",
  "the math package entry point",
];

const NEGATIVE_PATHS = [
  "packages/excalidraw/index.tsx",
  "src/db/connection.ts",
  "scripts/build-targets.sh",
  "docs/architecture/g-mesh-v1.md",
];

/** Identifier-shaped and plausible, but nowhere in either corpus. */
const NEGATIVE_INVENTED = [
  "QuantumFrobnicator",
  "resolveTelemetryBudget",
  "HyperbolicCacheWarden",
  "serializeGlyphAtlas",
  "computeParallaxOffsets",
];

function quantiles(xs: number[]): Record<string, number> {
  if (xs.length === 0) return {};
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number =>
    s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))] ?? Number.NaN;
  return {
    min: at(0),
    p10: at(0.1),
    p25: at(0.25),
    median: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: at(1),
  };
}

function report(right: RightAnswer[], none: NoAnswer[]): void {
  const found = right.filter((r) => r.correctScore !== null);
  const correctScores = found.map((r) => r.correctScore as number);
  const noneScores = none.map((n) => n.topScore).filter((s): s is number => s !== null);

  console.log(`\nRIGHT ANSWERS (${right.length} queries, correct hit found in ${found.length})`);
  console.log(" ", JSON.stringify(quantiles(correctScores)));
  console.log(`  ranked first: ${found.filter((r) => r.correctRank === 1).length}/${found.length}`);
  console.log(`  no correct hit at all: ${right.length - found.length}`);

  console.log(`\nNO RIGHT ANSWER (${none.length} queries)`);
  console.log(" ", JSON.stringify(quantiles(noneScores)));

  console.log("\nCUTOFF CANDIDATES");
  console.log("  cutoff  recall(right)  false-positive(none)");
  for (const c of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]) {
    const recall = correctScores.filter((s) => s >= c).length / Math.max(1, right.length);
    const fp = noneScores.filter((s) => s >= c).length / Math.max(1, noneScores.length);
    console.log(`  ${c.toFixed(2)}    ${(recall * 100).toFixed(0).padStart(3)}%          ${(fp * 100).toFixed(0).padStart(3)}%`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
