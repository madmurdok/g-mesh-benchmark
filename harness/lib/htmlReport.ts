import type { TokenEconomyRun } from "../token-economy.js";
import {
  armsPresent,
  computeAggregate,
  computeAnalysis,
  computeCategoryTokenBreakdown,
  computeCategoryTokenTable,
  computeCorrectnessTable,
  computeTaskTable,
  formatDurationSeconds,
  formatTurnsWithToolCalls,
  pairedTokenTotals,
  type Aggregate,
  type ArmAggregate,
  type CategoryTokenBreakdownRow,
  type CategoryTokenRow,
  type CorrectnessRow,
  type TaskRow,
} from "./reportData.js";
import type { Arm } from "./types.js";

/** Exported so lib/sessionReport.ts can share it rather than re-declaring the same five replacements. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Exported so lib/sessionReport.ts can share it rather than re-declaring the same formatter. */
export function fmt0(n: number): string {
  return n.toFixed(0);
}

/** Exported so lib/sessionReport.ts can share it rather than re-declaring the same formatter. */
export function fmt4(n: number): string {
  return n.toFixed(4);
}

// ---------------------------------------------------------------------------
// Chart 1: oracle pass rate by category — grouped vertical bars, y = 0-100%.
//
// Both charts below take the arm list as an argument (from armsPresent(), the
// same source report.ts uses) and lay out one bar slot per arm. With the usual
// two arms the geometry reduces exactly to the fixed two-bar layout these
// charts had before a third arm existed; a missing arm within a group leaves
// its slot empty rather than shifting the others.
// ---------------------------------------------------------------------------

function renderCorrectnessChart(rows: CorrectnessRow[], arms: Arm[]): string {
  const categories = [...new Set(rows.map((r) => r.category))];
  const byCategory = new Map<string, Map<Arm, CorrectnessRow>>();
  for (const r of rows) {
    const entry = byCategory.get(r.category) ?? new Map<Arm, CorrectnessRow>();
    entry.set(r.arm, r);
    byCategory.set(r.category, entry);
  }

  const armCount = Math.max(arms.length, 1);
  const width = Math.max(560, categories.length * 170);
  const height = 340;
  const marginTop = 34;
  const marginBottom = 56;
  const marginLeft = 44;
  const marginRight = 16;
  const plotWidth = width - marginLeft - marginRight;
  const plotHeight = height - marginTop - marginBottom;
  const groupWidth = plotWidth / Math.max(categories.length, 1);
  const groupPadding = Math.min(32, groupWidth * 0.25);
  const barGap = 2;
  const barWidth = Math.max(6, (groupWidth - groupPadding - barGap * (armCount - 1)) / armCount);
  const groupSpan = armCount * barWidth + (armCount - 1) * barGap;

  const yFor = (pct: number) => marginTop + plotHeight - (pct / 100) * plotHeight;

  const gridlines = [0, 25, 50, 75, 100]
    .map((pct) => {
      const y = yFor(pct);
      return (
        `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" class="gridline" />` +
        `<text x="${marginLeft - 8}" y="${y + 4}" class="axis-label" text-anchor="end">${pct}%</text>`
      );
    })
    .join("");

  const bars = categories
    .map((category, i) => {
      const groupX = marginLeft + i * groupWidth + groupPadding / 2;
      const entry = byCategory.get(category);
      const parts: string[] = [];

      arms.forEach((arm, armIndex) => {
        const row = entry?.get(arm);
        if (!row) return;
        const pct = (row.passed / row.total) * 100;
        const barHeight = (pct / 100) * plotHeight;
        const y = marginTop + plotHeight - barHeight;
        const x = groupX + armIndex * (barWidth + barGap);
        parts.push(
          `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barHeight, 0)}" rx="4" class="bar-${arm}"><title>${arm}, ${escapeHtml(category)}: ${row.passed}/${row.total}</title></rect>`,
          `<text x="${x + barWidth / 2}" y="${y - 6}" class="bar-label" text-anchor="middle">${row.passed}/${row.total}</text>`,
        );
      });

      const labelX = groupX + groupSpan / 2;
      parts.push(
        `<text x="${labelX}" y="${height - marginBottom + 20}" class="axis-label" text-anchor="middle">${escapeHtml(category)}</text>`,
      );
      return parts.join("");
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" class="chart" role="img" aria-label="Oracle pass rate by category">${gridlines}${bars}</svg>`;
}

// ---------------------------------------------------------------------------
// Chart 2: mean tokens by task — grouped horizontal bars.
// ---------------------------------------------------------------------------

function renderTokensChart(rows: TaskRow[], arms: Arm[]): string {
  const withData = rows.filter((r) => r.cells.some((c) => c.agg));
  const maxTokens = Math.max(1, ...withData.flatMap((r) => r.cells.map((c) => c.agg?.meanTokens ?? 0)));

  const armCount = Math.max(arms.length, 1);
  const width = 760;
  const marginLeft = 220;
  const marginRight = 90;
  const marginTop = 16;
  const marginBottom = 16;
  const rowHeight = 46;
  const barGap = 2;
  const barHeight = Math.max(6, (rowHeight - 10 - barGap * (armCount - 1)) / armCount);
  // Bar stack centred on the row, so a 2-arm chart lands on exactly the
  // half-bar-above / half-bar-below offsets this chart used before.
  const stackHeight = armCount * barHeight + (armCount - 1) * barGap;
  const plotWidth = width - marginLeft - marginRight;
  const height = marginTop + marginBottom + rows.length * rowHeight;

  const xFor = (tokens: number) => (tokens / maxTokens) * plotWidth;

  const bars = withData
    .map((row, i) => {
      const rowY = marginTop + i * rowHeight;
      const parts: string[] = [];
      const label = row.taskId.length > 30 ? row.taskId.slice(0, 27) + "…" : row.taskId;
      parts.push(
        `<text x="${marginLeft - 8}" y="${rowY + rowHeight / 2 + 4}" class="axis-label" text-anchor="end"><title>${escapeHtml(row.taskId)}</title>${escapeHtml(label)}</text>`,
      );

      arms.forEach((arm, armIndex) => {
        const agg = row.cells.find((c) => c.arm === arm)?.agg;
        if (!agg) return;
        const w = xFor(agg.meanTokens);
        const y = rowY + rowHeight / 2 - stackHeight / 2 + armIndex * (barHeight + barGap);
        parts.push(
          `<rect x="${marginLeft}" y="${y}" width="${Math.max(w, 0)}" height="${barHeight}" rx="4" class="bar-${arm}"><title>${arm}, ${escapeHtml(row.taskId)}: ${fmt0(agg.meanTokens)} tokens</title></rect>`,
          `<text x="${marginLeft + w + 6}" y="${y + barHeight / 2 + 4}" class="bar-label" text-anchor="start">${fmt0(agg.meanTokens)}</text>`,
        );
      });
      return parts.join("");
    })
    .join("");

  const baseline = `<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${height - marginBottom}" class="gridline" />`;

  return `<svg viewBox="0 0 ${width} ${height}" class="chart chart-wide" role="img" aria-label="Mean tokens by task">${baseline}${bars}</svg>`;
}

/** Exactly the arms present in the data, in the same order the bars are drawn. */
function legend(arms: Arm[]): string {
  const items = arms
    .map((arm) => `<span class="legend-item"><span class="swatch swatch-${arm}"></span>${escapeHtml(arm)}</span>`)
    .join("");
  return `<div class="legend">${items}</div>`;
}

function correctnessTableHtml(rows: CorrectnessRow[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.category)}</td><td>${r.arm}</td><td>${r.passed}/${r.total}</td><td>${((r.passed / r.total) * 100).toFixed(0)}%</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Category</th><th>Arm</th><th>Passed/Total</th><th>Pass rate</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/** `primaryArm` names the column `gmeshMeanTokens` holds — see reportData.ts's primaryComparisonArm. */
function categoryTokenTableHtml(rows: CategoryTokenRow[], primaryArm: Arm): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.category)}</td><td>${fmt0(r.gmeshMeanTokens)}</td><td>${fmt0(r.baselineMeanTokens)}</td><td>${r.savingsPct.toFixed(1)}%</td><td>${r.pairCount}</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Category</th><th>${escapeHtml(primaryArm)} mean tokens</th><th>baseline mean tokens</th><th>Savings</th><th>Pairs (n)</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * Splits the row above into the four fields tokensSpent() sums together. Each
 * category emits one row per arm (rather than arm-paired columns like
 * categoryTokenTableHtml) so a category with 4 token types x 2 arms stays
 * readable as 2 rows instead of 8 columns.
 */
function categoryTokenBreakdownTableHtml(rows: CategoryTokenBreakdownRow[]): string {
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.category)}</td><td>${r.arm}</td><td>${fmt0(r.meanInputTokens)}</td><td>${fmt0(r.meanOutputTokens)}</td><td>${fmt0(r.meanCacheCreationTokens)}</td><td>${fmt0(r.meanCacheReadTokens)}</td><td>${r.pairCount}</td></tr>`,
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Category</th><th>Arm</th><th>Input</th><th>Output</th><th>Cache create</th><th>Cache read</th><th>Pairs (n)</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function tokenTableHtml(rows: TaskRow[]): string {
  const cells = (agg: ArmAggregate | null, groupLen: number): string => {
    if (!agg) return groupLen > 0 ? `<td>0/${groupLen}</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>` : `<td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>`;
    return `<td>${agg.okCount}/${agg.total}</td><td>${fmt0(agg.meanTokens)}</td><td>${agg.bestTokens}</td><td>${agg.worstTokens}</td><td>${formatDurationSeconds(agg)}</td><td>${formatTurnsWithToolCalls(agg)}</td><td>${agg.passCount}/${agg.okCount}</td>`;
  };
  const body = rows
    .map((r) =>
      r.cells
        .filter((c) => c.agg || c.groupLength > 0)
        .map(
          (c) =>
            `<tr><td>${escapeHtml(r.taskId)}</td><td>${escapeHtml(r.expectedWinner)}</td><td>${escapeHtml(c.arm)}</td>${cells(c.agg, c.groupLength)}</tr>`,
        )
        .join(""),
    )
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Expected winner</th><th>Arm</th><th>Reps (ok/total)</th><th>Tokens mean</th><th>Tokens best</th><th>Tokens worst</th><th>Duration mean</th><th>Turns (tool calls)</th><th>Oracle (pass/ok)</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function statTile(label: string, value: string): string {
  return `<div class="stat-tile"><div class="stat-value">${value}</div><div class="stat-label">${escapeHtml(label)}</div></div>`;
}

export interface HtmlReportOptions {
  title: string;
  narrative?: string | null;
}

/**
 * Renders one complete, self-contained HTML document: no external CDN, no
 * client-side JS, no network calls — every chart is plain server-computed
 * SVG. Meant to be opened cold as a local file (file://), so every value a
 * reader needs is a direct label, never hover-only (a <title> is included on
 * each bar as a native-tooltip bonus, not the only way to read a value).
 */
export function renderHtmlReport(runs: TokenEconomyRun[], opts: HtmlReportOptions): string {
  const correctnessTable = computeCorrectnessTable(runs);
  const categoryTokenTable = computeCategoryTokenTable(runs);
  const categoryTokenBreakdown = computeCategoryTokenBreakdown(runs);
  const taskTable = computeTaskTable(runs);
  // Single source of truth for "which arms exist here" — shared with
  // report.ts/reportData.ts, so charts, legend and tables can never disagree.
  const arms = armsPresent(runs);
  const aggregate: Aggregate = computeAggregate(runs);
  const paired = pairedTokenTotals(runs);
  const analysis = computeAnalysis(runs, correctnessTable, taskTable, aggregate, paired);

  const pairedReductionPct = paired.totalBaseline > 0 ? ((paired.totalBaseline - paired.totalGmesh) / paired.totalBaseline) * 100 : null;
  const armSpend = runs.reduce((sum, r) => sum + r.costUsd, 0);
  const judgeSpend = runs.reduce((sum, r) => sum + (r.judgeCostUsd ?? 0), 0);

  const generatedAt = new Date().toISOString();
  const runTimestamp = runs[0]?.timestamp;

  const narrativeSection =
    opts.narrative && opts.narrative.trim().length > 0
      ? `<p class="narrative-text">${escapeHtml(opts.narrative).replace(/\n+/g, "</p><p class=\"narrative-text\">")}</p>`
      : `<p class="muted">Narrative generation skipped (disabled or unavailable).</p>`;

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
    /* Categorical slots 1-6 of this project's dataviz palette: blue, orange, green, violet, teal, magenta. */
    --gmesh: #2a78d6;
    --baseline: #eb6834;
    --gmesh-trusted: #1baf7a;
    --kungfu: #8b5cf6;
    /* gmesh-configured is the default primary arm; without its own slot it
       would fall through to an unstyled (black) bar and an empty legend
       swatch, since every bar/swatch class here is per-arm. */
    --gmesh-configured: #0f8fa8;
    --kungfu-configured: #c2549d;
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
      --kungfu: #a78bfa;
      --gmesh-configured: #24a6bf;
      --kungfu-configured: #d76bb2;
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
    --kungfu: #a78bfa;
    --gmesh-configured: #24a6bf;
    --kungfu-configured: #d76bb2;
  }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.15rem; margin: 40px 0 12px; }
  .timestamp { color: var(--text-secondary); font-size: 0.85rem; margin: 0 0 24px; }
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
  .swatch-kungfu { background: var(--kungfu); }
  .swatch-gmesh-configured { background: var(--gmesh-configured); }
  .swatch-kungfu-configured { background: var(--kungfu-configured); }
  .chart-wrap { overflow-x: auto; }
  svg.chart { width: 100%; height: auto; display: block; }
  svg.chart.chart-wide { min-width: 640px; }
  .gridline { stroke: var(--gridline); stroke-width: 1; }
  .axis-label { fill: var(--muted); font-size: 11px; }
  .bar-label { fill: var(--text-secondary); font-size: 11px; }
  .bar-gmesh { fill: var(--gmesh); }
  .bar-baseline { fill: var(--baseline); }
  .bar-gmesh-trusted { fill: var(--gmesh-trusted); }
  .bar-kungfu { fill: var(--kungfu); }
  .bar-gmesh-configured { fill: var(--gmesh-configured); }
  .bar-kungfu-configured { fill: var(--kungfu-configured); }
  .table-wrap { overflow-x: auto; margin-top: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--gridline); white-space: nowrap; }
  th { color: var(--text-secondary); font-weight: 600; }
  ul.analysis { padding-left: 20px; line-height: 1.6; }
  .narrative-text { line-height: 1.6; }
  .muted { color: var(--text-secondary); font-style: italic; }
</style>
</head>
<body>
<div class="viz-root">
  <h1>${escapeHtml(opts.title)}</h1>
  <p class="timestamp">Generated ${escapeHtml(generatedAt)}${runTimestamp ? ` &middot; run timestamp ${escapeHtml(runTimestamp)}` : ""}</p>

  <div class="stat-row">
    ${statTile("Unconditional reduction", `${aggregate.unconditionalReductionPct.toFixed(1)}%`)}
    ${statTile("Paired reduction", pairedReductionPct !== null ? `${pairedReductionPct.toFixed(1)}% (n=${paired.pairCount})` : `n/a (n=${paired.pairCount})`)}
    ${statTile("Arm spend", `$${fmt4(armSpend)}`)}
    ${statTile("Judge spend", `$${fmt4(judgeSpend)}`)}
    ${statTile(`${aggregate.arm} oracle pass rate`, `${aggregate.gmeshOracleOk}/${aggregate.gmeshOracleTotal}`)}
    ${statTile("baseline oracle pass rate", `${aggregate.baselineOracleOk}/${aggregate.baselineOracleTotal}`)}
  </div>

  <h2>Oracle pass rate by category</h2>
  ${legend(arms)}
  <div class="chart-wrap">${renderCorrectnessChart(correctnessTable, arms)}</div>
  ${correctnessTableHtml(correctnessTable)}

  <h2>Token savings by category (paired, oracle-passed pairs only)</h2>
  <p class="muted">${escapeHtml(aggregate.arm)} vs baseline, restricted to (task, repetition) pairs where both arms ran ok and passed oracle — same pairing discipline as the "Paired reduction" stat above, broken out per category so a category with few tasks (e.g. multihop) isn't diluted by the blended average.</p>
  ${categoryTokenTableHtml(categoryTokenTable, aggregate.arm)}

  <h2>Token type breakdown by category (paired, oracle-passed pairs only)</h2>
  <p class="muted">Same pairs as the table above, split into the four token types Anthropic bills separately instead of summed. Input is noise everywhere (5-15 tokens) since prompt caching absorbs almost everything into cache-create/cache-read. On categories where g-mesh wins (multi-hop, ambiguous-name), baseline typically pays more in BOTH cache-create (each grep/Read round-trip adds fresh, never-cached content) and cache-read (a longer transcript from more turns) — a compounding cost the summed total hides.</p>
  ${categoryTokenBreakdownTableHtml(categoryTokenBreakdown)}

  <h2>Mean tokens by task</h2>
  ${legend(arms)}
  <div class="chart-wrap">${renderTokensChart(taskTable, arms)}</div>
  ${tokenTableHtml(taskTable)}

  <h2>Automated observations</h2>
  <ul class="analysis">
    ${analysis.map((b) => `<li>${escapeHtml(b)}</li>`).join("\n    ")}
  </ul>

  <h2>Summary</h2>
  ${narrativeSection}
</div>
</body>
</html>
`;
}
