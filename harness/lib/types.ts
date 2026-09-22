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
 * - `gmesh-configured-map` — `gmesh-configured` plus g-mesh's repo map
 *   (`g-mesh map --write`, g-mesh >= 2.2.0). Byte-for-byte the same tools, MCP
 *   config and CLAUDE.md guidance as `gmesh-configured`; the only difference is
 *   an `AGENTS.md` in the throwaway clone carrying the PageRank-ranked,
 *   token-budgeted map block, plus the one-line `@AGENTS.md` bridge that makes
 *   Claude Code load it (verified empirically: Claude Code does *not* read a
 *   bare AGENTS.md, it does follow the bridge — same mechanism `g-mesh init
 *   --agent claude` ships). Exists to measure the ship gate in
 *   g-mesh/docs/architecture/pushed-context-repo-map.md: whether always-on
 *   pushed context buys more than it costs on the `lookup` category. See
 *   armConfig.ts's GMESH_MAP_CONFIGURED_CLAUDE_MD and corpusResolver.ts's
 *   writeRepoMap().
 * - `kungfu-configured` — the same real-delivery-path idea applied to
 *   `kungfu`: byte-for-byte the same restricted tool list/MCP config as
 *   `kungfu` (see armConfig.ts's KUNGFU_TOOLS/KUNGFU_DENIED_TOOLS), but run
 *   against a throwaway clone with kungfu's own documented CLAUDE.md
 *   recommendation auto-loaded, instead of bare kungfu with no setup guidance
 *   at all. Exists so a `gmesh-configured` vs `kungfu` comparison isn't
 *   unfair — g-mesh's own best-practice setup against kungfu's default. See
 *   armConfig.ts's KUNGFU_CONFIGURED_CLAUDE_MD.
 * - `serena` — [Serena](https://github.com/oraios/serena), an LSP-wrapper MCP
 *   server, restricted to the 5 tools with a genuine g-mesh analog plus the
 *   two it configures itself with (see armConfig.ts's SERENA_TOOLS/
 *   SERENA_DENIED_TOOLS). Was a `customArms` entry in
 *   g-mesh-bench.config.json until it needed a `-configured` variant, which
 *   only built-in arms can have. "Bare" in the same sense as bare `gmesh`: the
 *   tools with none of the setup its own docs prescribe, now opt-in via
 *   G_MESH_BENCH_INCLUDE_BARE_SERENA.
 * - `serena-configured` — the same real-delivery-path idea as the two
 *   `-configured` arms above, applied to Serena: byte-for-byte the same tools
 *   and MCP config as `serena`, run against a throwaway clone carrying
 *   Serena's own shipped Claude Code hooks (`serena-hooks activate/remind/
 *   cleanup`, see armConfig.ts's SERENA_CONFIGURED_SETTINGS_JSON) in
 *   `.claude/settings.json`. Serena delivers its setup through hooks rather
 *   than a project doc, which is why this one is a settings file where
 *   gmesh-configured/kungfu-configured are CLAUDE.md text.
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
  | "gmesh-configured-map"
  | "kungfu-configured"
  | "serena"
  | "serena-configured";

/**
 * An arm name as the harness accepts it anywhere at runtime: one of the
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
 * The three default arms lead, in the order the comparison is stated:
 * `gmesh-configured` (g-mesh as anyone actually runs it, with the CLAUDE.md
 * guidance in place), `serena-configured` (Serena as its own docs prescribe
 * running it, hooks and all), then `baseline` as the thing both are compared
 * against. The opt-in arms follow, each next to the default arm it is the
 * bare counterpart of — bare `gmesh` and bare `serena` — then the remaining
 * extras.
 *
 * Both `*-configured` arms were missing from this list entirely until
 * gmesh-configured became the default; they rendered via armsPresent()'s
 * unknown-arms-last fallback, i.e. always last regardless of what they were.
 * `serena` was in the same position for a different reason (it was a custom
 * arm, which this list never ranks). Listing them fixes both.
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
  "gmesh-configured-map",
  "serena-configured",
  "baseline",
  "gmesh",
  "serena",
  "gmesh-trusted",
  "kungfu",
  "kungfu-configured",
] satisfies readonly BuiltinArm[];

/**
 * A language `corpora/registry.json` may declare for a corpus via
 * `CorpusEntry.language`.
 *
 * Widened from `"ts" | "js"` for GMB-164 so a Go, Rust or Python corpus has a
 * value it's allowed to declare. Everything keyed off a corpus's language —
 * cold-start.ts's indexable-file walk, testRunner.ts's testCommand path
 * parser, runClaude.ts's file-mention regex — derives its extension list from
 * `LANGUAGE_EXTENSIONS` in lib/language.ts rather than hardcoding a second
 * TS/JS-shaped constant; see that file for why.
 */
export type CorpusLanguage = "ts" | "js" | "go" | "rust" | "python";

export interface CorpusEntry {
  id: string;
  kind: "local" | "git";
  path?: string;
  repoUrl?: string;
  ref?: string;
  /**
   * The commit every arm of every run measures this corpus at — a SHA, tag or
   * branch name, resolved to one commit per process by corpusResolver.ts's
   * resolveCorpusRevision() and checked out into every clone (warm, fresh and
   * configured alike).
   *
   * Optional so a new corpus can be registered without hunting a SHA first;
   * unpinned resolves `HEAD` for `kind: "local"` / `ref` for `kind: "git"`
   * and warns. Pinning is the recommended state for a corpus with tasks
   * authored against it: this benchmark's ground truth is content-anchored
   * (exact `mode: "pool"` file lists, `mode: "test"` tasks premised on a bug
   * present in a specific revision), so a corpus that tracks a live checkout's
   * HEAD silently changes what "correct" means between two runs. Bumping a pin
   * is the moment to re-run scripts/computeCandidatePool.ts — see README.
   */
  revision?: string;
  language: CorpusLanguage;
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
/**
 * "semantic-search" (added with g-mesh 1.1.0's `search_code` tool) covers
 * tasks that describe a symbol's *behavior* rather than name it — the prompt
 * deliberately shares no obvious unique grep keyword with the target, so
 * baseline has to guess and sift through matches while g-mesh can answer
 * directly via `search_code`'s ranked similarity search. Distinct from
 * "lookup" (which also omits the target's location but still names or
 * strongly implies the symbol/interface being asked about) precisely because
 * the prompt is a paraphrase, not a name.
 */
export type TaskCategory =
  | "lookup"
  | "multi-hop"
  | "ambiguous-name"
  | "control"
  | "scenario"
  | "feature-request"
  | "implementation"
  | "semantic-search";

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

/**
 * Which g-mesh capability a task's oracle actually exercises, per GMB-175:
 * `"structural"` for a task a plain graph walk (references/callers/
 * implementations/definition) can answer, `"semantic"` for one that needs
 * `search_code`'s similarity ranking because the prompt paraphrases its
 * target rather than naming it (see TaskCategory's `"semantic-search"` doc —
 * that's the category framing; this is the capability the oracle checks).
 * Lets a report slice "does g-mesh's structural graph win look different from
 * its semantic-search win" instead of only "does g-mesh win", which is what
 * GMB-160 asked tagging for in the first place.
 */
export type Tier = "structural" | "semantic";

export interface BenchTask {
  id: string;
  kind: string;
  category?: TaskCategory;
  /**
   * GMB-175 tagged all 23 existing tasks; optional so a task added without a
   * tier reads as untagged rather than defaulting into either bucket — see
   * reportData.ts's computeTierTable, which keeps an untagged task in its own
   * bucket rather than folding it into "structural".
   *
   * Compile-time only, same stance as `Arm`/`CorpusLanguage` above: this type
   * is checked wherever a `BenchTask` object literal is assigned or annotated
   * (e.g. a test fixture), but taskLoader.ts's `loadTasks()` reads
   * `corpora/*.json` through `JSON.parse(...) as BenchTask[]`, and `as` casts
   * from `any` skip TypeScript's excess-property/literal check entirely — so
   * a malformed `tier` in the JSON itself is not caught by this declaration
   * at load time, only a malformed `tier` in TypeScript source that names
   * this type.
   */
  tier?: Tier;
  /** false = prompt must not state target's file/symbol location; omitted defaults to true (v1 behavior) */
  revealsLocation?: boolean;
  expectedWinner?: ExpectedWinner;
  /** single-hop tasks use TaskTarget; category="multi-hop" tasks use steps[], one per chained lookup */
  target: TaskTarget | { steps: TaskTarget[] };
  prompt: string;
  oracle: Oracle;
  /**
   * Files copied into the run's cwd *before* the agent's turn starts — and
   * before any g-mesh index warm-up / repo-map generation a g-mesh arm does
   * for that cwd — keyed by destination path relative to the cwd, valued by
   * source path relative to this repo's root (conventionally
   * `corpora/<corpus>/fixtures/<task-id>/...`). Same shape and convention as
   * `oracle.holdoutFiles`, and the mirror image of it: a holdout is copied in
   * *after* the agent's turn so the agent can't read or rewrite the acceptance
   * criteria it's graded against; a seed is copied in *before*, so the agent —
   * and, for a g-mesh arm, the index and repo map — sees it as part of the
   * corpus.
   *
   * Exists for tasks that need the agent to react to a file that isn't part
   * of the corpus as shipped, e.g. a "what is wrong with this file"
   * diagnostics task needs a file with a known bug seeded in (the agent has
   * to see it to answer), not held out (which would hide it entirely).
   *
   * At task level rather than inside `Oracle`, because seeding what the agent
   * starts from is not grading what it produced.
   *
   * A task with `seedFiles` always gets its own throwaway clone per run
   * instead of sharing this harness's cached/reused checkouts (see
   * token-economy.ts's `taskNeedsOwnClone`): a seed dropped into a shared
   * clone would leak into every later task and repetition that reuses it,
   * since `git checkout --force` only resets tracked files and never removes
   * untracked ones.
   */
  seedFiles?: Record<string, string>;
}
