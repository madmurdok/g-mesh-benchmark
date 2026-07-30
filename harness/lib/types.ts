export interface CorpusEntry {
  id: string;
  kind: "local" | "git";
  path?: string;
  repoUrl?: string;
  ref?: string;
  language: "ts" | "js";
}

/**
 * "substring" is the v1 behavior (resultText.includes(...)) and the implicit
 * default when a task's oracle omits `mode` entirely, so every existing
 * corpora/*.json entry keeps grading exactly as before v2.
 */
export type GradingMode = "substring" | "pool" | "judge";

export type TaskCategory = "lookup" | "multi-hop" | "ambiguous-name" | "control";

/** Task author's hypothesis about which arm should win, surfaced in report.ts for interpretation only — never gates pass/fail. */
export type ExpectedWinner = "gmesh" | "baseline" | "parity";

export interface Oracle {
  mode?: GradingMode;
  /** substring mode */
  mustMentionFiles?: string[];
  /** substring mode */
  mustMentionSymbols?: string[];
  /** pool mode — full valid-answer set, computed independently of g-mesh (see scripts/computeCandidatePool.ts) */
  candidatePool?: string[];
  /** pool mode — how many candidatePool entries must appear in resultText to pass */
  minMatches?: number;
  /** judge mode — natural-language pass criteria evaluated by lib/judge.ts */
  rubric?: string;
}

export interface TaskTarget {
  symbol: string;
  file: string;
}

export interface BenchTask {
  id: string;
  kind: string;
  category?: TaskCategory;
  /** false = prompt must not state target's file/symbol location; omitted defaults to true (v1 behavior) */
  revealsLocation?: boolean;
  expectedWinner?: ExpectedWinner;
  /** single-hop tasks use TaskTarget; category="multi-hop" tasks use steps[], one per chained lookup */
  target: TaskTarget | { steps: TaskTarget[] };
  prompt: string;
  oracle: Oracle;
}
