/**
 * One benchmark arm — a single `claude -p` configuration a task is run under.
 *
 * - `gmesh` — g-mesh MCP tools plus Read/Grep/Glob, task prompt verbatim.
 * - `baseline` — Read/Grep/Glob only.
 * - `gmesh-trusted` — byte-for-byte the same MCP config and tool list as
 *   `gmesh`, differing only by a harness-injected instruction not to re-verify
 *   g-mesh's results by hand (see token-economy.ts's TRUSTED_ARM_PROMPT_SUFFIX
 *   and docs/results/v0.2.0-realistic-tasks-findings.md, "Turn-count evidence
 *   for the multi-hop self-verification pattern"). Keeping the tools identical
 *   is the point: it measures "chose not to verify", not "couldn't verify".
 *
 * Lives here rather than in token-economy.ts so reportData.ts/htmlReport.ts
 * share one definition instead of each re-declaring the union.
 */
export type Arm = "gmesh" | "baseline" | "gmesh-trusted";

/**
 * Fixed presentation order for arms in every table, chart and legend.
 * `gmesh`/`baseline` stay first so reports built from pre-`gmesh-trusted`
 * history render exactly as they did before that arm existed.
 */
export const ARM_ORDER: readonly Arm[] = ["gmesh", "baseline", "gmesh-trusted"];

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

/**
 * "scenario" (added post-v2) covers tasks framed around a concrete dev
 * moment — pre-change impact analysis, bug tracing from a symptom back to a
 * root cause, or a blast-radius/"is this safe to touch" question — rather
 * than an abstract "find every X" prompt. The underlying query shape often
 * overlaps with "lookup"/"multi-hop" (a references/callers walk), so this is
 * a framing tag, not a claim about tool-call complexity; see
 * docs/results/ for whether the framing measurably changes agent behavior.
 */
export type TaskCategory = "lookup" | "multi-hop" | "ambiguous-name" | "control" | "scenario";

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
