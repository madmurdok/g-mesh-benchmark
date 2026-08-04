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
 * - `kungfu` — a third-party code-intelligence MCP server (github.com/denyzhirkov/kungfu)
 *   used as an external comparison point, restricted to a curated tool subset
 *   matching g-mesh's 7 capabilities as closely as it has analogs for (see
 *   armConfig.ts's KUNGFU_TOOLS for the exact mapping and its documented gaps).
 * - `gmesh-configured` — the real-world counterpart to `gmesh-trusted`: same
 *   trust instruction, delivered as an actual project `CLAUDE.md` auto-loaded
 *   by Claude Code (via runClaude.ts's `--setting-sources project`) against a
 *   throwaway clone, instead of a harness-injected prompt suffix. See
 *   armConfig.ts's GMESH_CONFIGURED_CLAUDE_MD and corpusResolver.ts's
 *   resolveConfigured().
 * - `kungfu-configured` — the same real-delivery-path idea applied to
 *   `kungfu`: byte-for-byte the same restricted tool list/MCP config as
 *   `kungfu` (see armConfig.ts's KUNGFU_TOOLS/KUNGFU_DENIED_TOOLS), but run
 *   against a throwaway clone with kungfu's own documented CLAUDE.md
 *   recommendation auto-loaded, instead of bare kungfu with no setup guidance
 *   at all. Exists so a `gmesh-configured` vs `kungfu` comparison isn't
 *   unfair — g-mesh's own best-practice setup against kungfu's default. See
 *   armConfig.ts's KUNGFU_CONFIGURED_CLAUDE_MD.
 *
 * Lives here rather than in token-economy.ts so reportData.ts/htmlReport.ts
 * share one definition instead of each re-declaring the union.
 */
export type BuiltinArm =
  | "gmesh"
  | "baseline"
  | "gmesh-trusted"
  | "kungfu"
  | "gmesh-configured"
  | "kungfu-configured";

/**
 * An arm name as the harness accepts it anywhere at runtime: one of the six
 * built-ins above, or the name of a custom arm registered in
 * `g-mesh-bench.config.json`'s `customArms` (see lib/benchConfig.ts's
 * CustomArmDefinition and lib/armConfig.ts's fallback resolution) — a real MCP
 * server with a curated tool allowlist, registered without touching this file.
 *
 * `(string & {})` rather than a bare `string` is the standard open-union
 * idiom: it keeps every `BuiltinArm` literal in editor autocomplete and keeps
 * literal-typed values like `"gmesh"` inferring as themselves, while still
 * accepting an arbitrary custom name. Every existing value of the old closed
 * union still satisfies this type, so nothing that produced or consumed an
 * `Arm` before had to change.
 *
 * Deliberately *not* a validation boundary: a typo'd arm name is caught where
 * it enters the harness (benchConfig.ts's validateArms(), which accepts a
 * built-in or a registered `customArms` key and nothing else) and where it is
 * resolved (armConfig.ts, which throws naming both places an arm can be
 * defined), not by the type system.
 */
export type Arm = BuiltinArm | (string & {});

/**
 * Fixed presentation order for arms in every table, chart and legend.
 *
 * `gmesh-configured` leads because it is the default primary arm — g-mesh as
 * anyone actually runs it, with the CLAUDE.md guidance in place — and
 * `baseline` follows it as the thing it is being compared against. Bare
 * `gmesh` (now opt-in via G_MESH_BENCH_INCLUDE_BARE_GMESH) keeps third place
 * so a report built purely from pre-swap history still renders gmesh/baseline
 * in their old relative order, then the remaining opt-in arms.
 *
 * Both `*-configured` arms were missing from this list entirely until the
 * swap; they rendered via armsPresent()'s unknown-arms-last fallback, i.e.
 * always last regardless of what they were. Listing them fixes that.
 *
 * Built-in arms only, on purpose: a custom arm (see `Arm` above) has no
 * declared rank here and is appended alphabetically by armsPresent(), exactly
 * the fallback the two `*-configured` arms used before they were listed. The
 * `satisfies readonly BuiltinArm[]` keeps that a checked property — a typo or
 * a stray custom name in this list is a compile error — while the declared
 * `readonly Arm[]` is what lets reportData.ts/sessionReport.ts keep asking
 * `ARM_ORDER.includes(arm)`/`.indexOf(arm)` about an arbitrary recorded arm.
 */
export const ARM_ORDER: readonly Arm[] = [
  "gmesh-configured",
  "baseline",
  "gmesh",
  "gmesh-trusted",
  "kungfu",
  "kungfu-configured",
] satisfies readonly BuiltinArm[];

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
/**
 * "test" (added post-v2) is the only mode that doesn't grade the arm's *prose*
 * at all: the agent is expected to have edited real code, so the verdict comes
 * from running the corpus's own test suite plus a held-out acceptance test
 * copied in only after the agent's turn ends (see lib/testRunner.ts). It is
 * dispatched in token-economy.ts's runArm() before checkOracle() is reached —
 * process exit code and text matching have nothing in common beyond the
 * boolean they produce, so folding it into oracleCheck.ts would mean a mode
 * that ignores every argument that function takes.
 */
export type GradingMode = "substring" | "pool" | "judge" | "test";

/**
 * "scenario" (added post-v2) covers tasks framed around a concrete dev
 * moment — pre-change impact analysis, bug tracing from a symptom back to a
 * root cause, or a blast-radius/"is this safe to touch" question — rather
 * than an abstract "find every X" prompt. The underlying query shape often
 * overlaps with "lookup"/"multi-hop" (a references/callers walk), so this is
 * a framing tag, not a claim about tool-call complexity; see
 * docs/results/ for whether the framing measurably changes agent behavior.
 */
/**
 * "feature-request" (added post-v2) covers tasks framed as a real product ask
 * ("we want X") rather than a diagnostic question about existing behavior —
 * `scenario`'s bug-tracing/impact-analysis framing is retrospective, this one
 * is prospective. Still investigation-only (read-only tools, judge-graded
 * prose plan), same as every other category; no code is actually written.
 * See `implementation` for the category that does write code.
 */
/**
 * "implementation" (added post-v2) is the first category where the agent
 * actually changes the corpus: it gets Edit/Write on top of the arm's usual
 * read-only tools, runs against a throwaway clone of its own (never the shared
 * warm cwd), and is graded by `mode: "test"` — the corpus's real test suite
 * plus a held-out acceptance test — instead of by anything it says in prose.
 */
export type TaskCategory =
  | "lookup"
  | "multi-hop"
  | "ambiguous-name"
  | "control"
  | "scenario"
  | "feature-request"
  | "implementation";

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
  /**
   * test mode — acceptance files copied into the run's cwd *after* the agent's
   * turn has ended, keyed by destination path relative to that cwd, valued by
   * source path relative to this repo's root (conventionally
   * `corpora/<corpus>/fixtures/<task-id>/...`).
   *
   * Held out rather than shipped with the corpus so the agent can neither read
   * the acceptance criteria off disk nor edit the test into passing — it only
   * ever sees the prompt.
   */
  holdoutFiles?: Record<string, string>;
  /**
   * test mode — shell command run inside the run's cwd once the holdout files
   * are in place. Exit code 0 is the entire pass/fail verdict. Deliberately a
   * full command string (not just a test-runner name) so a corpus that needs
   * its dependencies installed in the throwaway clone first can say so.
   */
  testCommand?: string;
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
