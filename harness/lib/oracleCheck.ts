import type { Oracle } from "./types.js";
import { judgeAnswer } from "./judge.js";

export interface OracleCheckResult {
  passed: boolean;
  missed: string[];
  reason?: string;
  /**
   * judge mode only: what the grading call itself cost. Reported so the caller
   * can bound and record it; it is grading infrastructure and must never be
   * folded into the graded arm's own cost/token numbers.
   */
  judgeCostUsd?: number;
}

function checkSubstring(resultText: string, oracle: Oracle): OracleCheckResult {
  const missed = [...(oracle.mustMentionFiles ?? []), ...(oracle.mustMentionSymbols ?? [])].filter(
    (expected) => !resultText.includes(expected),
  );
  return { passed: missed.length === 0, missed };
}

function checkPool(resultText: string, oracle: Oracle): OracleCheckResult {
  const pool = oracle.candidatePool ?? [];
  const minMatches = oracle.minMatches ?? pool.length;
  const missed = pool.filter((candidate) => !resultText.includes(candidate));
  const hits = pool.length - missed.length;
  return { passed: hits >= minMatches, missed };
}

async function checkJudge(resultText: string, oracle: Oracle): Promise<OracleCheckResult> {
  if (!oracle.rubric) {
    return { passed: false, missed: [], reason: 'judge mode requires oracle.rubric', judgeCostUsd: 0 };
  }
  const verdict = await judgeAnswer(resultText, oracle.rubric);
  return { passed: verdict.passed, missed: [], reason: verdict.reason, judgeCostUsd: verdict.costUsd };
}

/**
 * Dispatches on oracle.mode: "substring" (default, v1 behavior — every
 * existing corpora/*.json entry omits `mode` and keeps grading identically),
 * "pool" (count candidatePool hits, pass at minMatches), or "judge"
 * (delegate to lib/judge.ts). Async because the judge path makes a real API
 * call; the other two modes resolve synchronously but share this signature.
 */
export async function checkOracle(resultText: string, oracle: Oracle): Promise<OracleCheckResult> {
  const mode = oracle.mode ?? "substring";
  switch (mode) {
    case "substring":
      return checkSubstring(resultText, oracle);
    case "pool":
      return checkPool(resultText, oracle);
    case "judge":
      return checkJudge(resultText, oracle);
  }
}
