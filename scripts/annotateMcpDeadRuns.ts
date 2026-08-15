/**
 * annotateMcpDeadRuns.ts — one-off, idempotent annotation of historical result
 * files whose arm ran without its MCP tools.
 *
 * The harness now refuses to *produce* such rows (lib/mcpHealth.ts aborts the
 * whole run), and `npm run report` refuses to *present* them (reportData.ts's
 * partitionByMcpAvailability / computeSilentMcpArms). Neither helps the files
 * already on disk: they were written before the harness looked at the CLI's
 * init event, so their records carry no `mcpServers`/`mcpToolCalls` at all, and
 * "no field" correctly means "unknown" everywhere in this codebase — not
 * "dead". This script supplies the missing fields for the specific
 * (file, arm) pairs where the failure is established by evidence, so the
 * report-time filters can see them.
 *
 * It is deliberately NOT a general backfill and takes no arguments: every entry
 * in MANIFEST below carries the evidence it rests on, and each annotated record
 * is stamped with `mcpAnnotation` naming that evidence — so an annotated record
 * can never be mistaken for one the harness actually measured. Nothing else in
 * a record is touched: `status`, tokens, oracle verdict and cost stay exactly as
 * recorded, because those numbers are real. What was wrong was never the
 * measurement; it was the label on the column.
 *
 * Usage (idempotent — re-running changes nothing):
 *   npx tsx scripts/annotateMcpDeadRuns.ts [--dry-run]
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TokenEconomyRun } from "../harness/token-economy.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ManifestEntry {
  /** Path relative to `results/`. */
  file: string;
  /** Which arm in that file ran without its tools. */
  arm: string;
  /** The MCP server that failed, as it is named in the arm's config. */
  server: string;
  /** Cited in every annotated record's `mcpAnnotation`. */
  evidence: string;
}

/**
 * The serena arm's MCP server failed to start on this machine from at least
 * 2026-08-14 (a corrupted uv cache clone of serena-agent, reproducible on demand
 * — see task #15 for the fix). Every run in the files below was left holding
 * Glob/Grep/Read, i.e. the baseline toolset, and was recorded as a valid serena
 * result.
 *
 * Deliberately stops here. Earlier serena runs are NOT annotated: the
 * 2026-08-11 sweep's serena-configured arm shows 6 median turns / 5 search calls
 * / 1032 median output tokens against baseline's 4 / 3 / 728 — a live tool's
 * signature, and nothing like the 2026-08-14 sweep's 4 / 3 / 774 next to
 * baseline's 4 / 3 / 794. Annotating those on suspicion would be the same
 * mistake as the one this whole task exists to fix, pointed the other way.
 */
const MANIFEST: ManifestEntry[] = [
  {
    file: "token-economy/2026-08-15T10-14-35-733Z.json",
    arm: "serena-configured",
    server: "serena",
    evidence:
      "results/transcripts/2026-08-15T10-15-33-689Z/*serena-configured*.ndjson — every init event carries " +
      'mcp_servers [{"name":"serena","status":"failed"}] and tools ["Glob","Grep","Read"]; no mcp__serena__* call anywhere',
  },
  {
    file: "token-economy/2026-08-15T10-22-09-857Z.json",
    arm: "serena-configured",
    server: "serena",
    evidence:
      "results/transcripts/2026-08-15T10-25-52-388Z/*serena-configured*.ndjson — every init event carries " +
      'mcp_servers [{"name":"serena","status":"failed"}] and tools ["Glob","Grep","Read"]; no mcp__serena__* call anywhere',
  },
  {
    file: "token-economy/2026-08-14T19-18-49-088Z.json",
    arm: "serena-configured",
    server: "serena",
    evidence:
      "the 2026-08-15 diagnostic re-run of this same configuration on this same machine (transcripts under " +
      "results/transcripts/2026-08-15T10-15-33-689Z/) reproduced the serena MCP server failing to start on every run; " +
      "consistent with this file's own aggregate, where serena-configured is indistinguishable from baseline " +
      "(median 4 turns / 3 search calls / 774 output tokens vs baseline's 4 / 3 / 794)",
  },
  {
    file: "token-economy/2026-08-14T19-14-28-863Z.json",
    arm: "serena-configured",
    server: "serena",
    evidence:
      "the smoke run four minutes before the 2026-08-14T19-18-49 sweep, on the same machine and the same corrupted " +
      "uv cache; it reported all three arms ok and was read as proof the wiring was sound",
  },
];

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  for (const entry of MANIFEST) {
    const filePath = path.join(ROOT, "results", entry.file);
    const runs = JSON.parse(await readFile(filePath, "utf8")) as TokenEconomyRun[];

    let annotated = 0;
    let alreadyAnnotated = 0;
    for (const run of runs) {
      if (run.arm !== entry.arm) continue;
      if (run.mcpAnnotation !== undefined) {
        alreadyAnnotated++;
        continue;
      }
      // A server that never started exposes no tools, so zero mcp__* calls is
      // not an inference — it is the only value the field can hold.
      run.mcpServers = [{ name: entry.server, status: "failed" }];
      run.mcpToolCalls = 0;
      run.mcpAnnotation =
        `MCP status added retroactively, not observed by the harness during this run ` +
        `(scripts/annotateMcpDeadRuns.ts). Evidence: ${entry.evidence}.`;
      annotated++;
    }

    console.log(
      `${entry.file}: ${annotated} ${entry.arm} run(s) annotated` +
        (alreadyAnnotated > 0 ? `, ${alreadyAnnotated} already annotated` : "") +
        (dryRun ? " (dry run, not written)" : ""),
    );
    // Same 2-space JSON the harness itself writes, so an annotated file stays
    // diffable against its unannotated neighbours.
    if (!dryRun && annotated > 0) await writeFile(filePath, JSON.stringify(runs, null, 2));
  }
}

main();
