import type { Oracle } from "./types.js";

export interface OracleCheckResult {
  passed: boolean;
  missed: string[];
}

export function checkOracle(resultText: string, oracle: Oracle): OracleCheckResult {
  const missed = [...oracle.mustMentionFiles, ...oracle.mustMentionSymbols].filter(
    (expected) => !resultText.includes(expected),
  );
  return { passed: missed.length === 0, missed };
}
