/**
 * analyzeToolUseLog.ts — GMB-177's one analysis script, two cuts.
 *
 * Turns the JSONL a `hooks/tool-use-logger.mjs` PostToolUse hook produces
 * into a summary. Usage:
 *
 *   npx tsx scripts/analyzeToolUseLog.ts <path-to-tool-use-log.jsonl> [--claude-md <path>]
 *
 * `--claude-md` defaults to `~/.claude/CLAUDE.md`, read-only, to size the
 * "Code search" routing-guidance section for cut 2's arithmetic. This script
 * never writes to `~/.claude/` — it only ever reads the log path and the
 * CLAUDE.md path it is given.
 *
 * THE LIMIT THIS DATA IS UNDER (GMB-177's whole premise): real sessions have
 * no oracle and no control arm. This script produces *descriptive* numbers —
 * which sequences occurred, how often, at what size, how often a rule's
 * situation arose — and NOTHING here is an evaluative claim ("X is better",
 * "rule Y is wrong"). That statement is reprinted in the summary's own
 * output, not left to the ticket, so a reader of the summary alone sees it.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { computeTokenSpread, formatTokenSpread } from "../harness/lib/reportData.js";

// ---------------------------------------------------------------------------
// Types + loading
// ---------------------------------------------------------------------------

interface ToolUseRecord {
  ts: string;
  session_id: string | null;
  tool_name: string;
  args_summary: string;
  response_bytes: number;
  error: boolean;
  markers?: Record<string, unknown>;
}

function loadRecords(logPath: string): { records: ToolUseRecord[]; malformedLines: number } {
  if (!existsSync(logPath)) {
    throw new Error(`log file not found: ${logPath}`);
  }
  const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const records: ToolUseRecord[] = [];
  let malformedLines = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.tool_name === "string" && typeof parsed.response_bytes === "number") {
        records.push(parsed as ToolUseRecord);
      } else {
        malformedLines++;
      }
    } catch {
      malformedLines++;
    }
  }
  return { records, malformedLines };
}

/** Records grouped by session_id, each group ordered by ts ascending. A record with no session_id groups under "(unknown)" rather than being dropped. */
function groupBySession(records: ToolUseRecord[]): Map<string, ToolUseRecord[]> {
  const groups = new Map<string, ToolUseRecord[]>();
  for (const r of records) {
    const key = r.session_id ?? "(unknown)";
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) {
    arr.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }
  return groups;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

// ---------------------------------------------------------------------------
// Cut 1: sequences
// ---------------------------------------------------------------------------

function ngramCounts(sessions: Map<string, ToolUseRecord[]>, n: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (const records of sessions.values()) {
    const names = records.map((r) => r.tool_name);
    for (let i = 0; i + n <= names.length; i++) {
      const key = names.slice(i, i + n).join(" → ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function topN(counts: Map<string, number>, n: number): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function computeCut1(records: ToolUseRecord[], sessions: Map<string, ToolUseRecord[]>) {
  const perToolCounts = new Map<string, number>();
  for (const r of records) perToolCounts.set(r.tool_name, (perToolCounts.get(r.tool_name) ?? 0) + 1);

  const responseBytes = records.map((r) => r.response_bytes).filter((b) => Number.isFinite(b) && b >= 0);
  const sortedBytes = [...responseBytes].sort((a, b) => a - b);
  const spread = responseBytes.length > 0 ? computeTokenSpread(responseBytes) : null;

  const errorCount = records.filter((r) => r.error).length;

  return {
    totalCalls: records.length,
    sessionCount: sessions.size,
    perToolCounts: [...perToolCounts.entries()].sort((a, b) => b[1] - a[1]),
    seq2: topN(ngramCounts(sessions, 2), 15),
    seq3: topN(ngramCounts(sessions, 3), 15),
    responseSize: {
      spread, // TokenSpread shape from GMB-117/harness/lib/reportData.ts — min–max(n=N), never a bare median.
      spreadFormatted: spread ? formatTokenSpread(spread) : "no data",
      p25: sortedBytes.length ? percentile(sortedBytes, 25) : NaN,
      p50: sortedBytes.length ? percentile(sortedBytes, 50) : NaN,
      p75: sortedBytes.length ? percentile(sortedBytes, 75) : NaN,
      p90: sortedBytes.length ? percentile(sortedBytes, 90) : NaN,
      n: sortedBytes.length,
    },
    errorCount,
    errorRate: records.length ? errorCount / records.length : NaN,
  };
}

// ---------------------------------------------------------------------------
// Cut 2: which CLAUDE.md "Code search" routing rules fire
// ---------------------------------------------------------------------------

type Observability = "yes" | "partial" | "no";

interface RuleDef {
  id: string;
  summary: string;
  observability: Observability;
  reason: string; // why observable/partial/not, and what the detector actually measures if partial/yes
  /** Only for observability "yes" | "partial". Returns opportunities (situations where the rule could apply) and fired (times the guided behavior was actually taken), plus a one-line note on what counts as which. */
  detect?: (sessions: Map<string, ToolUseRecord[]>) => { opportunities: number; fired: number; note: string };
}

const GMESH_PREFIX = "mcp__g-mesh__";
function isGMesh(name: string): boolean {
  return name.startsWith(GMESH_PREFIX);
}
function shortName(name: string): string {
  return isGMesh(name) ? name.slice(GMESH_PREFIX.length) : name;
}

const RULES: RuleDef[] = [
  {
    id: "R1a-prefer-gmesh-for-complex",
    summary: "Prefer g-mesh over grep for cross-file/ambiguous/call-graph questions; prefer grep for simple single-symbol lookups.",
    observability: "no",
    reason:
      'Whether a lookup was "simple/unambiguous" vs. "cross-file/ambiguous" is a property of the question being asked, not of the tool call made. A hook sees only which tool ran and its args/response shape, not the intent behind choosing it - nobody can check this one from a tool-call log alone.',
  },
  {
    id: "R1b-fallback-to-grep-after-gmesh-miss",
    summary: "Fall back to grep when g-mesh errors, returns no result, or the target isn't tracked.",
    observability: "yes",
    reason:
      "Opportunity = a g-mesh call whose record has error:true, or whose markers show allUnresolved:true / an empty result shape (proxied here by a very small response_bytes on a non-erroring call, since we don't store response content). Fired = the next tool call in the same session is Grep or Explore.",
    detect: (sessions) => {
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i]!;
          if (!isGMesh(r.tool_name)) continue;
          const looksLikeMiss = r.error === true || r.markers?.allUnresolved === true;
          if (!looksLikeMiss) continue;
          opportunities++;
          const next = records[i + 1];
          if (next && (next.tool_name === "Grep" || next.tool_name === "Explore")) fired++;
        }
      }
      return { opportunities, fired, note: "fired = next call in session is Grep/Explore after a g-mesh error/allUnresolved" };
    },
  },
  {
    id: "R2-no-manual-indexing",
    summary: "No manual indexing command exists or is needed; any g-mesh call bootstraps it.",
    observability: "no",
    reason: "Informational, not a decision point - there is no situation to have arisen or not; nothing to fire.",
  },
  {
    id: "R3-get-file-outline-before-full-read",
    summary: "Use get_file_outline(file) before reading a file in full, or to find the right symbol name.",
    observability: "partial",
    reason:
      'We can only observe a proxy: the share of Read calls on a file that were preceded (same session) by get_file_outline on that same file. We cannot tell whether the file was "unfamiliar" (the actual situation the rule governs), only whether the outline-first sequence occurred.',
    detect: (sessions) => {
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        const outlinedFiles = new Set<string>();
        for (const r of records) {
          if (r.tool_name === "mcp__g-mesh__get_file_outline") {
            const m = /"file_path":"([^"]*)"/.exec(r.args_summary);
            if (m) outlinedFiles.add(m[1]!);
          }
          if (r.tool_name === "Read") {
            const m = /"file_path":"([^"]*)"/.exec(r.args_summary);
            if (m) {
              opportunities++;
              if (outlinedFiles.has(m[1]!)) fired++;
            }
          }
        }
      }
      return { opportunities, fired, note: "fired = Read on a file previously outlined via get_file_outline in the same session" };
    },
  },
  {
    id: "R4-no-read-after-find-definition-source",
    summary: "find_definition's response already carries source.text; don't follow it with Read/Grep of that file.",
    observability: "yes",
    reason: "Opportunity = every find_definition call. Fired (as a violation, not compliance) = immediately followed by Read or Grep in the same session.",
    detect: (sessions) => {
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i]!;
          if (r.tool_name !== "mcp__g-mesh__find_definition") continue;
          opportunities++;
          const next = records[i + 1];
          if (next && (next.tool_name === "Read" || next.tool_name === "Grep")) fired++;
        }
      }
      return { opportunities, fired, note: "fired here = the guidance was NOT followed (a Read/Grep happened right after); this rule's firing rate counts violations, not compliance" };
    },
  },
  {
    id: "R5-find-definition-only-when-ambiguity-expected",
    summary: "Call find_definition first only when ambiguity is expected; otherwise call find_references/find_callers/etc directly with symbol_name.",
    observability: "partial",
    reason:
      "\"Ambiguity expected\" is a belief about the symbol, not observable. We can only measure the proxy rate of find_definition immediately preceding a find_references/find_callers/find_callees/find_implementations call on the same symbol in the same session - a real but weaker signal than the rule's actual condition.",
    detect: (sessions) => {
      const family = new Set(["find_references", "find_callers", "find_callees", "find_implementations"]);
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i]!;
          if (!isGMesh(r.tool_name) || !family.has(shortName(r.tool_name))) continue;
          opportunities++;
          const prev = records[i - 1];
          if (prev && prev.tool_name === "mcp__g-mesh__find_definition") fired++;
        }
      }
      return { opportunities, fired, note: "fired = find_definition called immediately before a find_references/find_callers/find_callees/find_implementations call, same session" };
    },
  },
  {
    id: "R6-ambiguous-requery-by-id",
    summary: "When a result carries ambiguous:true, re-query using a candidate's id as symbol_id, not qualifiedName.",
    observability: "yes",
    reason: "Opportunity = a g-mesh response with markers.ambiguous === true. Fired = the next call to the same tool in-session carries a symbol_id arg.",
    detect: (sessions) => {
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i]!;
          if (!isGMesh(r.tool_name) || r.markers?.ambiguous !== true) continue;
          opportunities++;
          const next = records[i + 1];
          if (next && next.tool_name === r.tool_name && /"symbol_id"/.test(next.args_summary)) fired++;
        }
      }
      return { opportunities, fired, note: "fired = same tool re-called next with a symbol_id argument" };
    },
  },
  {
    id: "R7-check-resolvedBy",
    summary: "Read resolvedBy before trusting a result; nameAmbiguous/fileName/semanticNeighbours mean candidates, not a resolved answer.",
    observability: "yes",
    reason: "Distribution of markers.resolvedBy values across g-mesh calls - directly observable, no proxy needed. Doesn't tell us whether the agent *acted* on the distinction, only how often each value occurred.",
    detect: (sessions) => {
      const dist = new Map<string, number>();
      let opportunities = 0;
      for (const records of sessions.values()) {
        for (const r of records) {
          if (!isGMesh(r.tool_name)) continue;
          const rb = r.markers?.resolvedBy;
          if (typeof rb === "string") {
            opportunities++;
            dist.set(rb, (dist.get(rb) ?? 0) + 1);
          }
        }
      }
      const weak = (dist.get("nameAmbiguous") ?? 0) + (dist.get("fileName") ?? 0) + (dist.get("semanticNeighbours") ?? 0);
      return { opportunities, fired: weak, note: `resolvedBy distribution: ${JSON.stringify([...dist.entries()])}; "fired" = candidate-only outcomes (nameAmbiguous/fileName/semanticNeighbours)` };
    },
  },
  {
    id: "R8-no-reverify-complete-result",
    summary: "Don't re-verify with grep/Read a find_references/find_callers/find_callees/find_implementations result that's already complete (resolved:true rows, no allUnresolved).",
    observability: "yes",
    reason: "Opportunity = a g-mesh call in that family whose markers show no allUnresolved and no hasUnresolvedRow. Fired (violation) = a Grep or Read call follows in the same session shortly after.",
    detect: (sessions) => {
      const family = new Set(["find_references", "find_callers", "find_callees", "find_implementations"]);
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i]!;
          if (!isGMesh(r.tool_name) || !family.has(shortName(r.tool_name))) continue;
          const complete = r.markers?.allUnresolved !== true && r.markers?.hasUnresolvedRow !== true;
          if (!complete) continue;
          opportunities++;
          const next = records[i + 1];
          if (next && (next.tool_name === "Grep" || next.tool_name === "Read")) fired++;
        }
      }
      return { opportunities, fired, note: "fired here = the guidance was NOT followed (a Grep/Read happened right after a complete result); counts violations, not compliance" };
    },
  },
  {
    id: "R9-find-references-not-find-callers-for-exhaustive",
    summary: "Use find_references instead of find_callers when the task needs an exhaustive caller list (find_callers misses REFERENCES edges).",
    observability: "no",
    reason: "\"Task needs an exhaustive caller list\" is intent, not visible in a tool call. The weak proxy - relative usage counts of find_callers vs find_references - doesn't tell us whether an exhaustive list was actually needed, so it isn't reported as a firing rate; usage counts alone would misrepresent this as measuring the rule.",
  },
  {
    id: "R10-use-files-array",
    summary: "When the question is about affected files, read the response's files array rather than deduplicating rows by hand or paging further.",
    observability: "partial",
    reason:
      '"The question is about files" is intent; not observable. What IS observable is the narrower, real proxy for the violation this rule prevents: a response with markers.filesPresent === true followed by the same tool re-called with a pagination-shaped arg (cursor/resume_token) in the same session - a wasted round trip the files array was meant to avoid.',
    detect: (sessions) => {
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i]!;
          if (!isGMesh(r.tool_name) || r.markers?.filesPresent !== true) continue;
          opportunities++;
          const next = records[i + 1];
          if (next && next.tool_name === r.tool_name && /"(cursor|resume_token)"/.test(next.args_summary)) fired++;
        }
      }
      return { opportunities, fired, note: "fired here = the guidance was NOT followed (paginated again right after a files array was already returned)" };
    },
  },
  {
    id: "R11-trust-truncated-false-follow-truncatedBy",
    summary: "Trust a get_dependencies result fully when truncated:false; when truncated:true, follow up keyed by truncatedBy (frontierNodes/pagination/resumeToken).",
    observability: "yes",
    reason: "Distribution of markers.truncated / markers.truncatedBy on get_dependencies calls is directly observable.",
    detect: (sessions) => {
      let opportunities = 0;
      let truncatedTrue = 0;
      const byReason = new Map<string, number>();
      for (const records of sessions.values()) {
        for (const r of records) {
          if (r.tool_name !== "mcp__g-mesh__get_dependencies") continue;
          if (typeof r.markers?.truncated !== "boolean") continue;
          opportunities++;
          if (r.markers.truncated === true) {
            truncatedTrue++;
            const tb = r.markers.truncatedBy;
            if (typeof tb === "string") byReason.set(tb, (byReason.get(tb) ?? 0) + 1);
          }
        }
      }
      return { opportunities, fired: truncatedTrue, note: `truncated:true rate; by truncatedBy: ${JSON.stringify([...byReason.entries()])}` };
    },
  },
  {
    id: "R12-no-regrep-for-imports",
    summary: "Don't re-derive an Incoming get_dependencies importer list with a `from ['\"]<module>` grep.",
    observability: "partial",
    reason: "Proxy: a get_dependencies(Incoming) call followed by a Grep whose truncated args_summary contains an import-statement-shaped pattern, in the same session.",
    detect: (sessions) => {
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i]!;
          if (r.tool_name !== "mcp__g-mesh__get_dependencies" || !/"direction":"Incoming"/.test(r.args_summary)) continue;
          opportunities++;
          const next = records[i + 1];
          if (next && next.tool_name === "Grep" && /from \[|import/.test(next.args_summary)) fired++;
        }
      }
      return { opportunities, fired, note: "fired here = the guidance was NOT followed (a from-statement-shaped Grep right after an Incoming walk); counts violations, not compliance" };
    },
  },
  {
    id: "R13-search-code-first-no-reroll-no-sweep",
    summary: 'search_code as the first move on a "find the function that does X" prompt with no named symbol; one confirming read after a hit, not reworded re-queries or a broad grep sweep.',
    observability: "partial",
    reason:
      '"No symbol name given in the prompt" is not visible to a hook. What is observable: (a) repeated search_code calls within one session (proxy for "reworded re-query hunting"), and (b) Grep calls preceding the first search_code/find_definition call in a session (proxy for "grep-guessed instead of using search_code first", the exact anti-pattern the CLAUDE.md rule cites by name).',
    detect: (sessions) => {
      let opportunities = 0; // sessions with >=1 search_code call
      let repeatedSearchCode = 0; // sessions with >1 search_code call
      let grepBeforeFirstSearch = 0; // sessions where a Grep preceded the first search_code call
      for (const records of sessions.values()) {
        const searchIdx = records.map((r, i) => (r.tool_name === "mcp__g-mesh__search_code" ? i : -1)).filter((i) => i >= 0);
        if (searchIdx.length === 0) continue;
        opportunities++;
        if (searchIdx.length > 1) repeatedSearchCode++;
        const firstIdx = searchIdx[0]!;
        if (records.slice(0, firstIdx).some((r) => r.tool_name === "Grep")) grepBeforeFirstSearch++;
      }
      return {
        opportunities,
        fired: repeatedSearchCode,
        note: `fired = sessions with search_code called >1 time (repeated-query anti-pattern); separately, ${grepBeforeFirstSearch}/${opportunities} sessions had a Grep before the first search_code call (grep-guessed-first anti-pattern)`,
      };
    },
  },
  {
    id: "R14-find-implementations-transitive-for-hierarchy",
    summary: "find_implementations only returns direct implementors by default; pass transitive:true for the whole hierarchy.",
    observability: "yes",
    reason: 'Opportunity = a find_implementations call without transitive:true. Fired = the very next call is find_implementations again, on the same symbol, this time WITH transitive:true (the retry pattern - direct evidence the first call needed the rule and didn\'t apply it).',
    detect: (sessions) => {
      let opportunities = 0;
      let fired = 0;
      for (const records of sessions.values()) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i]!;
          if (r.tool_name !== "mcp__g-mesh__find_implementations" || /"transitive":true/.test(r.args_summary)) continue;
          opportunities++;
          const next = records[i + 1];
          if (next && next.tool_name === r.tool_name && /"transitive":true/.test(next.args_summary)) fired++;
        }
      }
      return { opportunities, fired, note: "fired = immediately retried with transitive:true - a corrective round trip the default should have saved" };
    },
  },
];

// ---------------------------------------------------------------------------
// Cut 2 arithmetic: prompt cost per turn vs. one wasted round trip per firing
// ---------------------------------------------------------------------------

const BYTES_PER_TOKEN_APPROX = 4; // standard rough heuristic; NOT a measured figure for this repo's tokenizer - flagged as approximate everywhere it's used.

function extractCodeSearchSection(claudeMdText: string): string {
  const lines = claudeMdText.split("\n");
  const startIdx = lines.findIndex((l) => l.startsWith("# Code search"));
  if (startIdx === -1) throw new Error('"# Code search" heading not found in the given CLAUDE.md');
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("# ")) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join("\n");
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function computeSectionArithmetic(claudeMdPath: string) {
  if (!existsSync(claudeMdPath)) {
    return { available: false as const, reason: `${claudeMdPath} not found (read-only lookup; nothing written)` };
  }
  const text = readFileSync(claudeMdPath, "utf8");
  const section = extractCodeSearchSection(text);
  const sectionBytes = byteLen(section);
  const sectionTokensEstimate = Math.round(sectionBytes / BYTES_PER_TOKEN_APPROX);

  // Per-rule byte share: find each rule's own bullet text within the section
  // by its distinguishing quoted substring, when we have one, so the cost
  // split is measured off the actual doc text rather than assumed even.
  const bulletMarkers: Record<string, string> = {
    "R1a-prefer-gmesh-for-complex": "In TS/JS projects, prefer g-mesh",
    "R1b-fallback-to-grep-after-gmesh-miss": "In TS/JS projects, prefer g-mesh", // same bullet as R1a
    "R2-no-manual-indexing": "No manual indexing command",
    "R3-get-file-outline-before-full-read": "`get_file_outline(file_path)`",
    "R4-no-read-after-find-definition-source": "`find_definition(symbol_name)`",
    "R5-find-definition-only-when-ambiguity-expected": "`find_definition(symbol_name)`", // same bullet as R4
    "R6-ambiguous-requery-by-id": "If a `symbol_name` turns out ambiguous",
    "R7-check-resolvedBy": "Read `resolvedBy` before trusting",
    "R8-no-reverify-complete-result": "is complete for the question it answers",
    "R9-find-references-not-find-callers-for-exhaustive": "only ever walk `CALLS` edges",
    "R10-use-files-array": "When the question is about which *files* are affected",
    "R11-trust-truncated-false-follow-truncatedBy": "signaled by `truncated`/`truncatedBy`",
    "R12-no-regrep-for-imports": "Which imports produce those rows",
    "R13-search-code-first-no-reroll-no-sweep": "similarity-ranked, not a resolved graph query",
    "R14-find-implementations-transitive-for-hierarchy": "only returns direct implementors",
  };

  const perRuleBytes: Record<string, number | null> = {};
  const lines = section.split("\n");
  for (const [id, marker] of Object.entries(bulletMarkers)) {
    const line = lines.find((l) => l.includes(marker));
    perRuleBytes[id] = line ? byteLen(line) : null;
  }

  return {
    available: true as const,
    claudeMdPath,
    sectionBytes,
    sectionTokensEstimate,
    bytesPerTokenApprox: BYTES_PER_TOKEN_APPROX,
    perRuleBytes,
  };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const DESCRIPTIVE_LIMIT_NOTICE = `
================================================================================
LIMIT ON WHAT THIS DATA CAN SUPPORT (read before the numbers below)

Real sessions like the ones this log was built from have no oracle and no
control arm: nobody marked a right answer, and which sessions exist is
self-selected by what work happened to get done. Everything below is a
DESCRIPTIVE claim - which sequences occurred, how often, in what order, at
what size, how often a rule's situation arose - and NONE of it is an
EVALUATIVE claim. "This sequence is better" does not follow from any number
here. This applies with particular force to cut 2: a low firing rate is
evidence about COST (tokens spent on guidance nobody needed that turn), never
evidence that a rule is wrong or should be removed. Deciding whether to move
a rule into a hook is a separate decision informed by, but not settled by,
these numbers.
================================================================================
`;

function printCut1(cut1: ReturnType<typeof computeCut1>) {
  console.log("\n## Cut 1: sequences\n");
  console.log(`Total tool calls: ${cut1.totalCalls} across ${cut1.sessionCount} session(s).`);
  console.log(`Error rate: ${cut1.errorCount}/${cut1.totalCalls} (${isNaN(cut1.errorRate) ? "n/a" : (cut1.errorRate * 100).toFixed(1) + "%"})`);

  console.log("\nPer-tool call counts:");
  for (const [name, count] of cut1.perToolCounts) console.log(`  ${count.toString().padStart(4)}  ${name}`);

  console.log("\nResponse-size distribution (bytes) - spread, not a bare median (GMB-117 TokenSpread shape):");
  console.log(`  ${cut1.responseSize.spreadFormatted}`);
  if (cut1.responseSize.n > 0) {
    console.log(
      `  p25=${Math.round(cut1.responseSize.p25)}  p50=${Math.round(cut1.responseSize.p50)}  p75=${Math.round(cut1.responseSize.p75)}  p90=${Math.round(cut1.responseSize.p90)}  (n=${cut1.responseSize.n})`,
    );
  }

  console.log("\nTop length-2 sequences (within a session, not crossing session boundaries):");
  if (cut1.seq2.length === 0) console.log("  (none - fewer than 2 calls in any single session)");
  for (const [seq, count] of cut1.seq2) console.log(`  ${count.toString().padStart(4)}  ${seq}`);

  console.log("\nTop length-3 sequences:");
  if (cut1.seq3.length === 0) console.log("  (none - fewer than 3 calls in any single session)");
  for (const [seq, count] of cut1.seq3) console.log(`  ${count.toString().padStart(4)}  ${seq}`);
}

function printCut2(sessions: Map<string, ToolUseRecord[]>, arithmetic: ReturnType<typeof computeSectionArithmetic>) {
  console.log("\n## Cut 2: which CLAUDE.md \"Code search\" routing rules fire\n");

  if (arithmetic.available) {
    console.log(`Section measured from: ${arithmetic.claudeMdPath}`);
    console.log(`Section size: ${arithmetic.sectionBytes} bytes ≈ ${arithmetic.sectionTokensEstimate} tokens (at ~${arithmetic.bytesPerTokenApprox} bytes/token, a rough approximation - not this repo's actual tokenizer).`);
  } else {
    console.log(`Section arithmetic unavailable: ${arithmetic.reason}`);
  }

  console.log("\nPer rule:");
  for (const rule of RULES) {
    console.log(`\n- ${rule.id}: ${rule.summary}`);
    console.log(`  observability: ${rule.observability}`);
    console.log(`  ${rule.reason}`);
    if (rule.observability === "no" || !rule.detect) {
      console.log("  firing rate: NOT COMPUTABLE FROM THIS LOG (listed, not silently dropped)");
      continue;
    }
    const { opportunities, fired, note } = rule.detect(sessions);
    const rate = opportunities > 0 ? `${fired}/${opportunities} (${((fired / opportunities) * 100).toFixed(0)}%)` : "0/0 (no opportunities observed in this log)";
    console.log(`  firing rate: ${rate}`);
    console.log(`  ${note}`);

    if (arithmetic.available) {
      const ruleBytes = arithmetic.perRuleBytes[rule.id];
      if (ruleBytes != null) {
        const ruleTokensEstimate = Math.round(ruleBytes / arithmetic.bytesPerTokenApprox);
        console.log(
          `  arithmetic: this bullet is ~${ruleBytes}b (~${ruleTokensEstimate} tokens/turn, same bytes/token approximation) of prompt text paid on every turn of every session, whether or not its situation arises that turn. One wasted round trip when the rule DOES need to fire costs roughly (that turn's tool-call request tokens) + (that response's tokens, which then get re-read on every later turn in the session - see docs/results/v0.20.0-gmesh-2.8.1-token-economy-findings.md's cacheRead-dominance finding). This log's own response-size distribution above is the best available proxy for that second, dominant term; it is not computed per rule because the log has too few g-mesh calls to split it that finely (see cut 1). Breakeven is: (rule's per-turn token cost) × (turns per session) vs. (firing rate) × (one round trip's token cost) - both sides need real per-rule firing data this run's session(s) did not produce (g-mesh was unreachable). Numbers, not a conclusion: nothing here says whether this rule should move.`,
        );
      }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const logPath = args[0];
  if (!logPath) {
    console.error("usage: tsx scripts/analyzeToolUseLog.ts <path-to-tool-use-log.jsonl> [--claude-md <path>]");
    process.exit(1);
  }
  const claudeMdFlagIdx = args.indexOf("--claude-md");
  const claudeMdPath = claudeMdFlagIdx >= 0 ? args[claudeMdFlagIdx + 1]! : path.join(homedir(), ".claude", "CLAUDE.md");

  const { records, malformedLines } = loadRecords(logPath);
  const sessions = groupBySession(records);

  console.log(DESCRIPTIVE_LIMIT_NOTICE);
  console.log(`Log: ${logPath}`);
  console.log(`Parsed ${records.length} record(s); skipped ${malformedLines} malformed line(s).`);

  printCut1(computeCut1(records, sessions));
  printCut2(sessions, computeSectionArithmetic(claudeMdPath));

  console.log("\n" + DESCRIPTIVE_LIMIT_NOTICE);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
