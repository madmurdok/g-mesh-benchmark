import type { TokenEconomyRun } from "../token-economy.js";
import {
  computeAggregate,
  computeAnalysis,
  computeCorrectnessTable,
  computeTaskTable,
  pairedTokenTotals,
  type Aggregate,
  type CorrectnessRow,
  type TaskRow,
} from "./reportData.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt0(n: number): string {
  return n.toFixed(0);
}

function fmt4(n: number): string {
  return n.toFixed(4);
}

// ---------------------------------------------------------------------------
// Chart 1: oracle pass rate by category — grouped vertical bars, y = 0-100%.
// ---------------------------------------------------------------------------

function renderCorrectnessChart(rows: CorrectnessRow[]): string {
  const categories = [...new Set(rows.map((r) => r.category))];
  const byCategory = new Map<string, { gmesh?: CorrectnessRow; baseline?: CorrectnessRow }>();
  for (const r of rows) {
    const entry = byCategory.get(r.category) ?? {};
    entry[r.arm] = r;
    byCategory.set(r.category, entry);
  }

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
  const barWidth = Math.max(6, (groupWidth - groupPadding - barGap) / 2);

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
      const entry = byCategory.get(category) ?? {};
      const parts: string[] = [];

      if (entry.gmesh) {
        const pct = (entry.gmesh.passed / entry.gmesh.total) * 100;
        const barHeight = (pct / 100) * plotHeight;
        const y = marginTop + plotHeight - barHeight;
        parts.push(
          `<rect x="${groupX}" y="${y}" width="${barWidth}" height="${Math.max(barHeight, 0)}" rx="4" class="bar-gmesh"><title>gmesh, ${escapeHtml(category)}: ${entry.gmesh.passed}/${entry.gmesh.total}</title></rect>`,
          `<text x="${groupX + barWidth / 2}" y="${y - 6}" class="bar-label" text-anchor="middle">${entry.gmesh.passed}/${entry.gmesh.total}</text>`,
        );
      }
      if (entry.baseline) {
        const pct = (entry.baseline.passed / entry.baseline.total) * 100;
        const barHeight = (pct / 100) * plotHeight;
        const y = marginTop + plotHeight - barHeight;
        const x = groupX + barWidth + barGap;
        parts.push(
          `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(barHeight, 0)}" rx="4" class="bar-baseline"><title>baseline, ${escapeHtml(category)}: ${entry.baseline.passed}/${entry.baseline.total}</title></rect>`,
          `<text x="${x + barWidth / 2}" y="${y - 6}" class="bar-label" text-anchor="middle">${entry.baseline.passed}/${entry.baseline.total}</text>`,
        );
      }

      const labelX = groupX + barWidth + barGap / 2;
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

function renderTokensChart(rows: TaskRow[]): string {
  const withData = rows.filter((r) => r.gmesh || r.baseline);
  const maxTokens = Math.max(1, ...withData.map((r) => Math.max(r.gmesh?.meanTokens ?? 0, r.baseline?.meanTokens ?? 0)));

  const width = 760;
  const marginLeft = 220;
  const marginRight = 90;
  const marginTop = 16;
  const marginBottom = 16;
  const rowHeight = 46;
  const barGap = 2;
  const barHeight = Math.max(6, (rowHeight - 10 - barGap) / 2);
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

      if (row.gmesh) {
        const w = xFor(row.gmesh.meanTokens);
        const y = rowY + rowHeight / 2 - barHeight - barGap / 2;
        parts.push(
          `<rect x="${marginLeft}" y="${y}" width="${Math.max(w, 0)}" height="${barHeight}" rx="4" class="bar-gmesh"><title>gmesh, ${escapeHtml(row.taskId)}: ${fmt0(row.gmesh.meanTokens)} tokens</title></rect>`,
          `<text x="${marginLeft + w + 6}" y="${y + barHeight / 2 + 4}" class="bar-label" text-anchor="start">${fmt0(row.gmesh.meanTokens)}</text>`,
        );
      }
      if (row.baseline) {
        const w = xFor(row.baseline.meanTokens);
        const y = rowY + rowHeight / 2 + barGap / 2;
        parts.push(
          `<rect x="${marginLeft}" y="${y}" width="${Math.max(w, 0)}" height="${barHeight}" rx="4" class="bar-baseline"><title>baseline, ${escapeHtml(row.taskId)}: ${fmt0(row.baseline.meanTokens)} tokens</title></rect>`,
          `<text x="${marginLeft + w + 6}" y="${y + barHeight / 2 + 4}" class="bar-label" text-anchor="start">${fmt0(row.baseline.meanTokens)}</text>`,
        );
      }
      return parts.join("");
    })
    .join("");

  const baseline = `<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${height - marginBottom}" class="gridline" />`;

  return `<svg viewBox="0 0 ${width} ${height}" class="chart chart-wide" role="img" aria-label="Mean tokens by task">${baseline}${bars}</svg>`;
}

function legend(): string {
  return (
    `<div class="legend">` +
    `<span class="legend-item"><span class="swatch swatch-gmesh"></span>gmesh</span>` +
    `<span class="legend-item"><span class="swatch swatch-baseline"></span>baseline</span>` +
    `</div>`
  );
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

function tokenTableHtml(rows: TaskRow[]): string {
  const cells = (agg: TaskRow["gmesh"], groupLen: number): string => {
    if (!agg) return groupLen > 0 ? `<td>0/${groupLen}</td><td>-</td><td>-</td><td>-</td><td>-</td>` : `<td>-</td><td>-</td><td>-</td><td>-</td><td>-</td>`;
    return `<td>${agg.okCount}/${agg.total}</td><td>${fmt0(agg.meanTokens)}</td><td>${agg.bestTokens}</td><td>${agg.worstTokens}</td><td>${agg.passCount}/${agg.okCount}</td>`;
  };
  const body = rows
    .map((r) => {
      const gmeshRow = r.gmesh || r.gmeshGroupLength > 0
        ? `<tr><td>${escapeHtml(r.taskId)}</td><td>${escapeHtml(r.expectedWinner)}</td><td>gmesh</td>${cells(r.gmesh, r.gmeshGroupLength)}</tr>`
        : "";
      const baselineRow = r.baseline || r.baselineGroupLength > 0
        ? `<tr><td>${escapeHtml(r.taskId)}</td><td>${escapeHtml(r.expectedWinner)}</td><td>baseline</td>${cells(r.baseline, r.baselineGroupLength)}</tr>`
        : "";
      return gmeshRow + baselineRow;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Expected winner</th><th>Arm</th><th>Reps (ok/total)</th><th>Tokens mean</th><th>Tokens best</th><th>Tokens worst</th><th>Oracle (pass/ok)</th></tr></thead><tbody>${body}</tbody></table></div>`;
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
  const taskTable = computeTaskTable(runs);
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
    --gmesh: #2a78d6;
    --baseline: #eb6834;
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
  .chart-wrap { overflow-x: auto; }
  svg.chart { width: 100%; height: auto; display: block; }
  svg.chart.chart-wide { min-width: 640px; }
  .gridline { stroke: var(--gridline); stroke-width: 1; }
  .axis-label { fill: var(--muted); font-size: 11px; }
  .bar-label { fill: var(--text-secondary); font-size: 11px; }
  .bar-gmesh { fill: var(--gmesh); }
  .bar-baseline { fill: var(--baseline); }
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
    ${statTile("gmesh oracle pass rate", `${aggregate.gmeshOracleOk}/${aggregate.gmeshOracleTotal}`)}
    ${statTile("baseline oracle pass rate", `${aggregate.baselineOracleOk}/${aggregate.baselineOracleTotal}`)}
  </div>

  <h2>Oracle pass rate by category</h2>
  ${legend()}
  <div class="chart-wrap">${renderCorrectnessChart(correctnessTable)}</div>
  ${correctnessTableHtml(correctnessTable)}

  <h2>Mean tokens by task</h2>
  ${legend()}
  <div class="chart-wrap">${renderTokensChart(taskTable)}</div>
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
