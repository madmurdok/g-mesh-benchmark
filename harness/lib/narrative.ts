import { runClaude } from "./runClaude.js";
import { buildBaselineArmConfig } from "./mcpConfig.js";
import type { Aggregate } from "./reportData.js";

/**
 * Cheap/fast model, same choice as judge.ts's JUDGE_MODEL — narrative
 * generation is a small summarization pass, not a measured arm.
 */
const NARRATIVE_MODEL = "claude-haiku-4-5";
/**
 * Matches JUDGE_MAX_BUDGET_USD (judge.ts) rather than a tighter cap: a
 * smaller value (0.02) was tried first and verified to be routinely
 * exceeded by real per-call cache-creation overhead alone, before any
 * output tokens — it made the narrative section fall back to "skipped" on
 * almost every run, defeating the point of generating one at all.
 */
export const NARRATIVE_MAX_BUDGET_USD = 0.05;

function buildNarrativePrompt(bullets: string[], aggregate: Aggregate): string {
  return [
    "You are writing a short plain-English summary of a benchmark report for a developer who is deciding whether " +
      "to adopt a code-navigation tool called g-mesh over plain grep/Read/Glob.",
    "",
    "Base your summary strictly on the facts below. Do not invent any numbers that are not present here.",
    "",
    "Aggregate numbers:",
    `- Tasks compared: ${aggregate.taskCount}`,
    `- Total mean tokens — gmesh: ${aggregate.totalGmeshTokens.toFixed(0)}, baseline: ${aggregate.totalBaselineTokens.toFixed(0)}`,
    `- Unconditional token reduction: ${aggregate.unconditionalReductionPct.toFixed(1)}%`,
    `- Oracle pass rate — gmesh: ${aggregate.gmeshOracleOk}/${aggregate.gmeshOracleTotal}, baseline: ${aggregate.baselineOracleOk}/${aggregate.baselineOracleTotal}`,
    "",
    "Automated observations:",
    ...bullets.map((b) => `- ${b}`),
    "",
    "Write a 150-250 word plain-English summary grounded strictly in the numbers and observations above. " +
      "Respond with the summary text only, no headers, no JSON, no markdown formatting.",
  ].join("\n");
}

/**
 * One extra `claude -p` call that turns computeAnalysis()'s deterministic
 * bullets into readable prose for the HTML report. Its cost is returned
 * separately (costUsd) and must never be folded into arm/judge spend — same
 * "own budget, own line item" pattern as lib/judge.ts's JUDGE_MAX_BUDGET_USD.
 *
 * Never throws: any failure (bad JSON... there is none to parse here, but a
 * non-ok status, an empty response, a budget overrun, or a thrown error from
 * runClaude itself) returns null so report generation is never blocked by a
 * narrative failure.
 */
export async function generateNarrative(
  bullets: string[],
  aggregate: Aggregate,
): Promise<{ text: string; costUsd: number } | null> {
  try {
    const result = await runClaude({
      cwd: process.cwd(),
      prompt: buildNarrativePrompt(bullets, aggregate),
      mcpConfig: buildBaselineArmConfig(),
      tools: "",
      model: NARRATIVE_MODEL,
      maxBudgetUsd: NARRATIVE_MAX_BUDGET_USD,
    });

    if (result.status !== "ok") return null;
    const text = result.resultText.trim();
    if (text.length === 0) return null;

    return { text, costUsd: result.costUsd };
  } catch {
    return null;
  }
}
