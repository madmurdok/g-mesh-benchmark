import { runClaude } from "./runClaude.js";
import { buildBaselineArmConfig } from "./mcpConfig.js";

/**
 * Cheap/fast model used only for grading, never for a measured arm — kept
 * separate from token-economy.ts's MODEL constant so a change to the model
 * under test never silently changes what grades it.
 */
const JUDGE_MODEL = "claude-haiku-4-5";
/** Exported so token-economy.ts can bound arm+judge spend against the same number, instead of duplicating it. */
export const JUDGE_MAX_BUDGET_USD = 0.05;

export interface JudgeResult {
  passed: boolean;
  reason: string;
  costUsd: number;
}

function buildJudgePrompt(resultText: string, rubric: string): string {
  return [
    "You are grading whether an AI agent's answer satisfies a rubric. Do not solve the task yourself — only judge the answer given.",
    "",
    `Rubric: ${rubric}`,
    "",
    "Answer to grade:",
    "```",
    resultText,
    "```",
    "",
    'Respond with exactly one JSON object and nothing else, in the form: {"passed": true or false, "reason": "one short sentence"}',
  ].join("\n");
}

function parseVerdict(resultText: string): { passed: boolean; reason: string } {
  const match = resultText.match(/\{[\s\S]*\}/);
  if (!match) {
    return { passed: false, reason: `judge did not return parseable JSON: ${resultText.slice(0, 200)}` };
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.passed !== "boolean") {
      return { passed: false, reason: `judge JSON missing boolean "passed": ${match[0].slice(0, 200)}` };
    }
    return { passed: parsed.passed, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
  } catch {
    return { passed: false, reason: `judge returned invalid JSON: ${match[0].slice(0, 200)}` };
  }
}

/**
 * One extra `claude -p` call that grades `resultText` against a
 * natural-language `rubric`. Its cost is returned separately (costUsd) and
 * must never be folded into an arm's own token/cost numbers — it's grading
 * infrastructure, not part of either arm's task-completion cost.
 */
export async function judgeAnswer(resultText: string, rubric: string): Promise<JudgeResult> {
  const result = await runClaude({
    cwd: process.cwd(),
    prompt: buildJudgePrompt(resultText, rubric),
    mcpConfig: buildBaselineArmConfig(),
    tools: "",
    model: JUDGE_MODEL,
    maxBudgetUsd: JUDGE_MAX_BUDGET_USD,
  });

  if (result.status !== "ok") {
    return { passed: false, reason: `judge call did not succeed (status: "${result.status}")`, costUsd: result.costUsd };
  }

  const verdict = parseVerdict(result.resultText);
  return { ...verdict, costUsd: result.costUsd };
}
