import type { SessionEconomyRun } from "../session-economy.js";
import { escapeHtml } from "./htmlReport.js";
import { armsPresent, computeCorrectnessTable, tokensSpent, type CorrectnessRow } from "./reportData.js";
import { ARM_ORDER, type Arm } from "./types.js";

/**
 * Report for the session-economy experiment.
 *
 * Deliberately its own module rather than an extension of lib/htmlReport.ts:
 * that report is built around the gmesh-vs-baseline correctness/token-savings
 * framing and has no concept of "cost by position within a session", and three
 * other consumers already depend on it unchanged. What this one adds — the
 * per-position amortization curve — is the whole point of the experiment, so
 * it is the headline here and would be a bolt-on there.
 */

export interface SequencePositionRow {
  corpusId: string;
  arm: Arm;
  sequenceIndex: number;
  /** How many ok runs went into the means below. Cells with no ok run are omitted entirely, never emitted as 0. */
  n: number;
  meanTotalTokens: number;
  meanCacheCreationTokens: number;
}

function armRank(arm: Arm): number {
  const index = ARM_ORDER.indexOf(arm);
  // Unknown arms (a record from a future harness) sort after the known ones
  // rather than being dropped — same policy as reportData.ts's armsPresent.
  return index === -1 ? ARM_ORDER.length : index;
}

/**
 * Mean cost per position in a chained session, grouped by (corpus, arm,
 * sequenceIndex).
 *
 * Grouping is strictly per corpus, never pooled across corpora. Chains have
 * different lengths (task-tracker-mcp has 5 tasks, excalidraw 15), so a pooled
 * position 7 would contain only excalidraw runs while position 2 contained
 * both — silently confounding "later in the session" with "a different
 * codebase". For the same reason a position past a shorter corpus's length is
 * simply absent from that corpus's rows rather than zero-filled.
 *
 * Only status === "ok" runs contribute: a "skipped" (chain aborted before it)
 * or "error" run has no measurement, and counting it would read as a free,
 * successful call.
 */
export function computeSequenceTokenTable(runs: SessionEconomyRun[]): SequencePositionRow[] {
  const buckets = new Map<string, { corpusId: string; arm: Arm; sequenceIndex: number; total: number[]; cacheCreation: number[] }>();

  for (const run of runs) {
    if (run.status !== "ok") continue;
    const key = `${run.corpusId}::${run.arm}::${run.sequenceIndex}`;
    const bucket =
      buckets.get(key) ?? { corpusId: run.corpusId, arm: run.arm, sequenceIndex: run.sequenceIndex, total: [], cacheCreation: [] };
    bucket.total.push(tokensSpent(run));
    bucket.cacheCreation.push(run.cacheCreationTokens);
    buckets.set(key, bucket);
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  return [...buckets.values()]
    .map((b) => ({
      corpusId: b.corpusId,
      arm: b.arm,
      sequenceIndex: b.sequenceIndex,
      n: b.total.length,
      meanTotalTokens: mean(b.total),
      meanCacheCreationTokens: mean(b.cacheCreation),
    }))
    .sort(
      (a, b) =>
        a.corpusId.localeCompare(b.corpusId) || armRank(a.arm) - armRank(b.arm) || a.sequenceIndex - b.sequenceIndex,
    );
}

function fmt0(n: number): string {
  return n.toFixed(0);
}

function fmt4(n: number): string {
  return n.toFixed(4);
}

// ---------------------------------------------------------------------------
// Chart: cache-creation tokens by position in session — one line per arm.
//
// cache_creation_input_tokens is the metric this experiment exists to watch:
// it is where an isolated `claude -p` process re-pays for the MCP tool schemas
// from cold, and where a continuing session should stop paying after its first
// call. Mean total tokens are in the table beside the chart rather than as a
// second set of lines — two series per arm on one axis reads as noise at 15
// positions, and the exact values are better read as numbers anyway.
//
// Same house conventions as htmlReport.ts's charts: server-computed SVG, no
// script, no external assets, <title> tooltips as a bonus on top of a table
// that already carries every value.
// ---------------------------------------------------------------------------

export function renderSequenceChart(rows: SequencePositionRow[], corpusId: string, arms: Arm[]): string {
  const corpusRows = rows.filter((r) => r.corpusId === corpusId);
  if (corpusRows.length === 0) {
    return `<p class="muted">No completed runs for ${escapeHtml(corpusId)} yet.</p>`;
  }

  const positions = [...new Set(corpusRows.map((r) => r.sequenceIndex))].sort((a, b) => a - b);
  const maxPosition = Math.max(...positions);
  const maxTokens = Math.max(1, ...corpusRows.map((r) => r.meanCacheCreationTokens));

  const width = Math.max(560, maxPosition * 60);
  const height = 340;
  const marginTop = 24;
  const marginBottom = 56;
  const marginLeft = 64;
  const marginRight = 20;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;

  // A one-position chart would divide by zero; pin its single point mid-plot.
  const xFor = (position: number) =>
    maxPosition > 1 ? marginLeft + ((position - 1) / (maxPosition - 1)) * plotWidth : marginLeft + plotWidth / 2;
  const yFor = (tokens: number) => marginTop + plotHeight - (tokens / maxTokens) * plotHeight;

  const gridlines = [0, 0.25, 0.5, 0.75, 1]
    .map((frac) => {
      const value = maxTokens * frac;
      const y = yFor(value);
      return (
        `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" class="gridline" />` +
        `<text x="${marginLeft - 8}" y="${y + 4}" class="axis-label" text-anchor="end">${fmt0(value)}</text>`
      );
    })
    .join("");

  const xLabels = positions
    .map(
      (position) =>
        `<text x="${xFor(position)}" y="${height - marginBottom + 20}" class="axis-label" text-anchor="middle">${position}</text>`,
    )
    .join("");
  const xAxisTitle = `<text x="${marginLeft + plotWidth / 2}" y="${height - marginBottom + 42}" class="axis-label" text-anchor="middle">position in session</text>`;

  const series = arms
    .map((arm) => {
      const armRows = corpusRows.filter((r) => r.arm === arm).sort((a, b) => a.sequenceIndex - b.sequenceIndex);
      if (armRows.length === 0) return "";
      const points = armRows.map((r) => `${xFor(r.sequenceIndex)},${yFor(r.meanCacheCreationTokens)}`).join(" ");
      const line = `<polyline points="${points}" class="line line-${arm}" />`;
      const dots = armRows
        .map(
          (r) =>
            `<circle cx="${xFor(r.sequenceIndex)}" cy="${yFor(r.meanCacheCreationTokens)}" r="4" class="dot-${arm}">` +
            `<title>${escapeHtml(arm)}, position ${r.sequenceIndex}: ${fmt0(r.meanCacheCreationTokens)} cache-creation tokens (n=${r.n})</title></circle>`,
        )
        .join("");
      return line + dots;
    })
    .join("");

  return (
    `<svg viewBox="0 0 ${width} ${height}" class="chart chart-wide" role="img" ` +
    `aria-label="Mean cache-creation tokens by position in session for ${escapeHtml(corpusId)}">` +
    `${gridlines}${xLabels}${xAxisTitle}${series}</svg>`
  );
}

function legend(arms: Arm[]): string {
  const items = arms
    .map((arm) => `<span class="legend-item"><span class="swatch swatch-${arm}"></span>${escapeHtml(arm)}</span>`)
    .join("");
  return `<div class="legend">${items}</div>`;
}

function sequenceTableHtml(rows: SequencePositionRow[], corpusId: string): string {
  const body = rows
    .filter((r) => r.corpusId === corpusId)
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.arm)}</td><td>${r.sequenceIndex}</td><td>${r.n}</td>` +
        `<td>${fmt0(r.meanCacheCreationTokens)}</td><td>${fmt0(r.meanTotalTokens)}</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Arm</th><th>Position</th><th>Runs (n)</th><th>Mean cache-creation tokens</th><th>Mean total tokens</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function correctnessTableHtml(rows: CorrectnessRow[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.category)}</td><td>${escapeHtml(r.arm)}</td><td>${r.passed}/${r.total}</td><td>${((r.passed / r.total) * 100).toFixed(0)}%</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Category</th><th>Arm</th><th>Passed/Total</th><th>Pass rate</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

interface ChainSummary {
  corpusId: string;
  arm: Arm;
  repetition: number;
  sessionId: string;
  ok: number;
  skipped: number;
  failed: number;
  length: number;
  costUsd: number;
}

/**
 * One row per chain — the audit trail for "did this session actually stay one
 * session?". A chain that aborted shows up as ok < length with the remainder
 * in skipped, rather than just looking short.
 */
function chainSummaries(runs: SessionEconomyRun[]): ChainSummary[] {
  const byChain = new Map<string, ChainSummary>();
  for (const run of runs) {
    const key = `${run.corpusId}::${run.arm}::${run.repetition}`;
    const entry =
      byChain.get(key) ??
      {
        corpusId: run.corpusId,
        arm: run.arm,
        repetition: run.repetition,
        sessionId: "-",
        ok: 0,
        skipped: 0,
        failed: 0,
        length: run.sessionLength,
        costUsd: 0,
      };
    if (run.status === "ok") entry.ok++;
    else if (run.status === "skipped") entry.skipped++;
    else entry.failed++;
    if (run.claudeSessionId) entry.sessionId = run.claudeSessionId;
    entry.costUsd += run.costUsd + run.judgeCostUsd;
    byChain.set(key, entry);
  }
  return [...byChain.values()].sort(
    (a, b) => a.corpusId.localeCompare(b.corpusId) || armRank(a.arm) - armRank(b.arm) || a.repetition - b.repetition,
  );
}

function chainTableHtml(chains: ChainSummary[]): string {
  const body = chains
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.corpusId)}</td><td>${escapeHtml(c.arm)}</td><td>${c.repetition}</td>` +
        `<td>${c.ok}/${c.length}</td><td>${c.skipped}</td><td>${c.failed}</td><td>$${fmt4(c.costUsd)}</td>` +
        `<td class="mono">${escapeHtml(c.sessionId)}</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Corpus</th><th>Arm</th><th>Chain</th><th>Completed</th><th>Skipped</th><th>Failed</th><th>Spend</th><th>Final session id</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * The headline number: what one arm pays in cache-creation tokens on the first
 * call of a session versus every later call in it.
 *
 * Pooled across corpora on purpose, unlike the per-position table — this
 * contrast is "first call vs the rest", not "position k vs position k", and
 * every corpus contributes to both sides of it, so differing chain lengths
 * cannot swap one corpus in for another the way they would at a fixed
 * position. Null when either side has no ok runs.
 */
function amortization(runs: SessionEconomyRun[], arm: Arm): { first: number; later: number; dropPct: number } | null {
  const ok = runs.filter((r) => r.status === "ok" && r.arm === arm);
  const first = ok.filter((r) => r.sequenceIndex === 1).map((r) => r.cacheCreationTokens);
  const later = ok.filter((r) => r.sequenceIndex > 1).map((r) => r.cacheCreationTokens);
  if (first.length === 0 || later.length === 0) return null;
  const meanFirst = first.reduce((a, b) => a + b, 0) / first.length;
  const meanLater = later.reduce((a, b) => a + b, 0) / later.length;
  return { first: meanFirst, later: meanLater, dropPct: meanFirst > 0 ? ((meanFirst - meanLater) / meanFirst) * 100 : 0 };
}

function statTile(label: string, value: string): string {
  return `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${escapeHtml(label)}</div></div>`;
}

export interface SessionHtmlReportOptions {
  title: string;
  narrative?: string | null;
}

/**
 * One complete, self-contained HTML document — no CDN, no client-side JS, no
 * network calls, every chart server-computed SVG — matching lib/htmlReport.ts's
 * conventions so both reports read as the same product.
 */
export function renderSessionHtmlReport(runs: SessionEconomyRun[], opts: SessionHtmlReportOptions): string {
  const arms = armsPresent(runs);
  const sequenceTable = computeSequenceTokenTable(runs);
  const correctnessTable = computeCorrectnessTable(runs);
  const chains = chainSummaries(runs);
  const corpusIds = [...new Set(sequenceTable.map((r) => r.corpusId))].sort();

  const armSpend = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const judgeSpend = runs.reduce((sum, r) => sum + (r.judgeCostUsd ?? 0), 0);
  const okCount = runs.filter((r) => r.status === "ok").length;
  const skippedCount = runs.filter((r) => r.status === "skipped").length;

  const amortizationTiles = arms
    .map((arm) => {
      const a = amortization(runs, arm);
      // Signed explicitly: dropPct goes negative when later calls cost *more*
      // than the first (e.g. the first call landed on an already-warm prefix),
      // and a hardcoded minus would render that as "--758%".
      const delta = a ? `${a.dropPct >= 0 ? "-" : "+"}${Math.abs(a.dropPct).toFixed(0)}%` : "";
      return statTile(
        `${arm}: cache-creation, first call vs later`,
        a ? `${fmt0(a.first)} → ${fmt0(a.later)} (${delta})` : "n/a",
      );
    })
    .join("\n    ");

  const perCorpusSections = corpusIds
    .map(
      (corpusId) =>
        `<h2>${escapeHtml(corpusId)}: cache-creation tokens by position in session</h2>\n` +
        `  ${legend(arms)}\n` +
        `  <div class="chart-wrap">${renderSequenceChart(sequenceTable, corpusId, arms)}</div>\n` +
        `  ${sequenceTableHtml(sequenceTable, corpusId)}`,
    )
    .join("\n\n  ");

  const generatedAt = new Date().toISOString();
  const runTimestamp = runs[0]?.timestamp;

  const narrativeSection =
    opts.narrative && opts.narrative.trim().length > 0
      ? `<p class="narrative-text">${escapeHtml(opts.narrative).replace(/\n+/g, "</p><p class=\"narrative-text\">")}</p>`
      : `<p class="muted">Narrative generation is not part of this experiment.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(opts.title)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .viz-root {
    color-scheme: light;
    --surface-1: #fcfcfb;
    --surface-2: #f2f1ec;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --muted: #898781;
    --gridline: #e1e0d9;
    /* Categorical slots 1-3 of this project's dataviz palette: blue, orange, aqua. */
    --gmesh: #2a78d6;
    --baseline: #eb6834;
    --gmesh-trusted: #1baf7a;
    background: var(--surface-1);
    color: var(--text-primary);
    padding: 24px clamp(16px, 4vw, 48px) 64px;
    max-width: 1100px;
    margin: 0 auto;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) .viz-root {
      color-scheme: dark;
      --surface-1: #1a1a19;
      --surface-2: #232322;
      --text-primary: #ffffff;
      --text-secondary: #c3c2b7;
      --muted: #898781;
      --gridline: #2c2c2a;
      --gmesh: #3987e5;
      --baseline: #d95926;
      --gmesh-trusted: #199e70;
    }
  }
  :root[data-theme="dark"] .viz-root {
    color-scheme: dark;
    --surface-1: #1a1a19;
    --surface-2: #232322;
    --text-primary: #ffffff;
    --text-secondary: #c3c2b7;
    --muted: #898781;
    --gridline: #2c2c2a;
    --gmesh: #3987e5;
    --baseline: #d95926;
    --gmesh-trusted: #199e70;
  }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; }
  .timestamp { color: var(--text-secondary); font-size: 0.85rem; margin: 0 0 24px; }
  .lede { color: var(--text-secondary); line-height: 1.6; margin: 0 0 20px; }
  .stat-row { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 8px; }
  .stat-tile { background: var(--surface-2); border-radius: 8px; padding: 12px 16px; flex: 1 1 160px; }
  .stat-value { font-size: 1.4rem; font-weight: 600; }
  .stat-label { color: var(--text-secondary); font-size: 0.8rem; margin-top: 2px; }
  .legend { display: flex; gap: 16px; margin-bottom: 8px; font-size: 0.85rem; color: var(--text-secondary); }
  .legend-item { display: inline-flex; align-items: center; gap: 6px; }
  .swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .swatch-gmesh { background: var(--gmesh); }
  .swatch-baseline { background: var(--baseline); }
  .swatch-gmesh-trusted { background: var(--gmesh-trusted); }
  .chart-wrap { overflow-x: auto; }
  svg.chart { width: 100%; height: auto; display: block; }
  svg.chart.chart-wide { min-width: 640px; }
  .gridline { stroke: var(--gridline); stroke-width: 1; }
  .axis-label { fill: var(--muted); font-size: 11px; }
  .line { fill: none; stroke-width: 2; }
  .line-gmesh { stroke: var(--gmesh); }
  .line-baseline { stroke: var(--baseline); }
  .line-gmesh-trusted { stroke: var(--gmesh-trusted); }
  .dot-gmesh { fill: var(--gmesh); }
  .dot-baseline { fill: var(--baseline); }
  .dot-gmesh-trusted { fill: var(--gmesh-trusted); }
  .table-wrap { overflow-x: auto; margin-top: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--gridline); white-space: nowrap; }
  th { color: var(--text-secondary); font-weight: 600; }
  td.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.78rem; }
  .narrative-text { line-height: 1.6; }
  .muted { color: var(--text-secondary); font-style: italic; }
</style>
</head>
<body>
<div class="viz-root">
  <h1>${escapeHtml(opts.title)}</h1>
  <p class="timestamp">Generated ${escapeHtml(generatedAt)}${runTimestamp ? ` &middot; run timestamp ${escapeHtml(runTimestamp)}` : ""}</p>
  <p class="lede">Every task of a corpus asked inside one continuing <code>claude -p</code> session per arm, instead of
  one fresh process per task. The number to watch is cache-creation tokens by position: an isolated process re-pays for
  the MCP tool schemas on every call, a real session pays once. Positions are grouped strictly per corpus — chains have
  different lengths, so pooling them would confuse "later in the session" with "a different codebase".</p>

  <div class="stat-row">
    ${amortizationTiles}
    ${statTile("Chains", String(chains.length))}
    ${statTile("Runs ok / skipped", `${okCount} / ${skippedCount}`)}
    ${statTile("Arm spend", `$${fmt4(armSpend)}`)}
    ${statTile("Judge spend", `$${fmt4(judgeSpend)}`)}
  </div>

  ${perCorpusSections}

  <h2>Sessions</h2>
  ${chainTableHtml(chains)}

  <h2>Oracle pass rate by category</h2>
  ${correctnessTableHtml(correctnessTable)}

  <h2>Summary</h2>
  ${narrativeSection}
</div>
</body>
</html>
`;
}
