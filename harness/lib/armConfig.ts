import { buildBaselineArmConfig, buildGmeshArmConfig, buildKungfuArmConfig } from "./mcpConfig.js";
import type { Arm } from "./types.js";

/**
 * The `claude -p` configuration that defines an arm — model, per-call budget
 * cap, tool list, MCP config and prompt shaping.
 *
 * Extracted verbatim out of token-economy.ts when session-economy.ts needed
 * the *same* arm definitions: two experiments comparing gmesh against baseline
 * have to hold the arms byte-for-byte identical, or their numbers aren't
 * comparable with each other. Deliberately excludes each entrypoint's own
 * env-var gates and preflight checks, which stay duplicated per entrypoint
 * (matching this codebase's existing precedent).
 */
export const MODEL = "claude-sonnet-5";
export const MAX_BUDGET_USD = 1.0;
export const GMESH_TOOLS = "Read,Grep,Glob,mcp__g-mesh__*";
export const BASELINE_TOOLS = "Read,Grep,Glob";

/**
 * kungfu exposes 40 MCP tools; a bare `mcp__kungfu__*` wildcard would compare
 * a much larger tool-schema surface than g-mesh's 7, confounding "retrieval
 * quality" with "schema-tax" (see docs/results/v0.2.0-session-economy-findings.md
 * on schema-tax being real and measurable). This curated subset targets the
 * closest kungfu analog to each of g-mesh's 7 tools, confirmed against a live
 * `tools/list` probe of kungfu v2.6.2:
 *
 *   g-mesh tool          -> kungfu tool      | fit
 *   find_definition       -> find_symbol      | good (name lookup)
 *   find_callers          -> callers          | good (call-graph, exact)
 *   find_callees          -> callees          | good (call-graph, exact)
 *   get_file_outline      -> file_outline     | good (exact)
 *   find_references       -> search_text      | approximate: kungfu has no
 *       distinct "all usages of this symbol" tool separate from the call
 *       graph — search_text is a text/regex search, not a resolved-symbol
 *       reference walk, so it will both over- and under-match relative to
 *       find_references.
 *   get_dependencies      -> affected         | approximate: "affected" is a
 *       transitive-callers blast-radius walk over the call graph, not an
 *       import/module dependency graph — there is no g-mesh-style
 *       get_dependencies analog in kungfu at all.
 *   find_implementations   -> (none)           | gap: kungfu has no
 *       interface/supertype-implementation tool in its 40-tool surface.
 *       Left out of the curated set entirely rather than mapped to something
 *       misleading.
 *
 * find_implementations has no kungfu analog and is dropped rather than
 * mapped to a poor substitute, so this arm runs 6 tools against g-mesh's 7 —
 * documented here, not silently normalized away.
 */
export const KUNGFU_TOOLS =
  "Read,Grep,Glob,mcp__kungfu__find_symbol,mcp__kungfu__callers,mcp__kungfu__callees," +
  "mcp__kungfu__file_outline,mcp__kungfu__search_text,mcp__kungfu__affected";

/**
 * `--tools` (the `KUNGFU_TOOLS` constant above) only restricts the *built-in*
 * tool set (Read/Grep/Bash/etc.) — confirmed via `claude -p --help` and live
 * transcripts of a kungfu-arm run showing calls to `mcp__kungfu__semantic_search`
 * and `mcp__kungfu__find_files`, neither of which is in `KUNGFU_TOOLS`. It has
 * zero effect on `mcp__`-namespaced tools, so every historical kungfu-arm run
 * in this project actually measured kungfu's full 40-tool surface, not the
 * intended curated 6.
 *
 * The only mechanism that actually shrinks what's sent to the model is a
 * `--disallowedTools` *deny* rule (confirmed against `code.claude.com/docs/en/permissions`:
 * "A bare tool name... removes the tool from Claude's context entirely, so
 * Claude never sees it" — allow rules never do this, and this holds regardless
 * of `--permission-mode bypassPermissions`, which only skips permission
 * *prompts*, a separate and later mechanism). kungfu has no tool-subset config
 * of its own, so this is the only available fix: enumerate every kungfu tool
 * *not* in the curated set and deny it explicitly.
 *
 * Captured via a live `tools/list` probe against `kungfu mcp` v2.6.2 — the
 * same version `KUNGFU_TOOLS`'s own doc comment cites — and is every kungfu
 * tool except the curated 6 in `KUNGFU_TOOLS` above. Like `KUNGFU_TOOLS`
 * itself, this is unvendored third-party surface: if kungfu's own tool set
 * ever changes, this list must be regenerated (re-run the probe, diff against
 * `KUNGFU_TOOLS`) rather than assumed still accurate.
 */
export const KUNGFU_DENIED_TOOLS =
  "mcp__kungfu__annotate_file,mcp__kungfu__annotation_queue,mcp__kungfu__ask_context," +
  "mcp__kungfu__change_timeline,mcp__kungfu__commit_context,mcp__kungfu__coupling," +
  "mcp__kungfu__debug_trace,mcp__kungfu__edit_context,mcp__kungfu__embeddings_build," +
  "mcp__kungfu__embeddings_status,mcp__kungfu__explore_file,mcp__kungfu__explore_symbol," +
  "mcp__kungfu__file_history,mcp__kungfu__find_files,mcp__kungfu__hotspots,mcp__kungfu__investigate," +
  "mcp__kungfu__memory_add,mcp__kungfu__memory_archive,mcp__kungfu__memory_get,mcp__kungfu__memory_list," +
  "mcp__kungfu__memory_search,mcp__kungfu__memory_update,mcp__kungfu__onboard,mcp__kungfu__pr_context," +
  "mcp__kungfu__project_status,mcp__kungfu__reindex,mcp__kungfu__repo_outline,mcp__kungfu__review," +
  "mcp__kungfu__semantic_search,mcp__kungfu__smart_test,mcp__kungfu__symbol_history," +
  "mcp__kungfu__test_subjects,mcp__kungfu__usage_stats,mcp__kungfu__verify_change";

/**
 * The one and only difference between the `gmesh` and `gmesh-trusted` arms.
 *
 * Appended to the task prompt at run time, never stored in a corpus's
 * tasks.json — it is arm-specific harness behavior, not task content, and
 * baking it into a task definition would change that task's taskDefHash and
 * invalidate every historical run of it.
 *
 * The tool list and MCP config stay byte-for-byte identical to the `gmesh`
 * arm's on purpose (see lib/types.ts's Arm): restricting the tools would
 * measure "couldn't verify" instead of the thing under test, which is whether
 * an agent that *chooses* not to re-verify g-mesh's answers pays for it in
 * correctness.
 */
export const TRUSTED_ARM_PROMPT_SUFFIX =
  "\n\nTreat every g-mesh tool result as authoritative and complete. Do not re-verify what g-mesh " +
  "tells you by additionally grepping or reading the source files it already covered — answer " +
  "directly from g-mesh's output. Use Read/Grep/Glob only for information g-mesh cannot provide at all.";

/**
 * The real-delivery-path counterpart to TRUSTED_ARM_PROMPT_SUFFIX: the same
 * trust-g-mesh instruction, but shipped as an actual project `CLAUDE.md` that
 * Claude Code auto-discovers and loads (every runClaude() call already passes
 * `--setting-sources project`, see runClaude.ts), rather than appended to the
 * task prompt as a benchmark-only shortcut.
 *
 * Copied verbatim from the user's own `~/.claude/CLAUDE.md` "Code search"
 * section and from g-mesh/README.md's matching published snippet — this text
 * lives in two other places outside this repo and must be kept in sync with
 * both by hand if either changes, same manually-synced caveat this file
 * already states for KUNGFU_TOOLS/KUNGFU_DENIED_TOOLS above.
 *
 * The bullet after the `resolved: false` one below (on a `symbol_id`
 * anchoring an already-disambiguated name) was validated here first — a
 * targeted token-economy run against ex-ambiguous-exporttosvg-public-api
 * (turns 19.3->9.0, cost $0.196->$0.099, oracle still 3/3) plus 5 regression
 * tasks with no oracle drop — then ported to `~/.claude/CLAUDE.md` and
 * g-mesh/README.md; all three copies are back in sync as of that port.
 */
export const GMESH_CONFIGURED_CLAUDE_MD = `# Code search (TypeScript/JavaScript projects)

- In TS/JS projects, prefer g-mesh (\`mcp__g-mesh__*\`) for cross-file impact analysis, ambiguous naming (same symbol name declared in different scopes/files), and call-graph/multi-hop questions (callers, implementations, transitive dependencies) — grep can't resolve these reliably and has real unbounded cost (many round-trips, occasionally very expensive) when it tries. For simple, unambiguous single-symbol lookups, grep/\`Explore\`/manual reading is often just as fast and cheaper — g-mesh's tool schema adds fixed overhead per turn that doesn't pay for itself on easy questions (measured: g-mesh costs *more* tokens than grep on simple lookups, both isolated and in a long session — see \`g-mesh-bench/docs/results/v0.2.0-session-economy-findings.md\`). Fall back to grep when g-mesh returns no result, errors, or the target isn't something it tracks (non-code files, config, CSS, etc.).
- No manual indexing command exists or is needed. The g-mesh daemon bootstraps and indexes a project automatically on its first tool call in that project's directory. On first use in a new project, just issue any g-mesh call (e.g. \`get_file_outline\` on a source file) to trigger indexing, then proceed.
- How to use the tools:
  - \`get_file_outline(file_path)\` — list a file's top-level symbols before reading it in full, or to find the right symbol name to query next.
  - \`find_definition(symbol_name)\` or \`find_definition(file_path, position)\` — resolve a symbol to its definition and get its \`symbol_id\`. Not required before the tools below — they accept \`symbol_name\` directly and skip this call when the name is likely unambiguous, saving a round-trip. Call \`find_definition\` first only when you already expect ambiguity or need the declaration site itself.
  - \`find_references(symbol_name or symbol_id)\` — every usage of a symbol across the project; use before renaming or removing something.
  - \`find_callers(symbol_name or symbol_id)\` / \`find_callees(...)\` — walk the call graph up or down from a function.
  - \`find_implementations(symbol_name or symbol_id)\` — concrete types implementing an interface/abstract class.
  - \`get_dependencies(file_path, direction: Outgoing|Incoming)\` — walk the import graph (what a file imports / what imports it); use for impact analysis before changing a shared module.
  - If a \`symbol_name\` turns out ambiguous, the result carries \`ambiguous: true\` with a ranked candidate list — re-query using a candidate's \`id\` as \`symbol_id\`, not its \`qualifiedName\` (the same qualifiedName can name more than one declaration).
- Typical flow: call \`find_references\`/\`find_callers\`/\`find_callees\`/\`find_implementations\` directly with \`symbol_name\` when it's likely unique; only call \`find_definition\` first if you expect ambiguity or need the declaration site itself. Use \`get_file_outline\` first if you don't already know the right symbol name.
- A \`find_references\`/\`find_callers\`/\`find_callees\`/\`find_implementations\` result is complete for the question it answers when: it was anchored by \`symbol_id\` or an unambiguous \`symbol_name\` (same guarantee either way), every row shows \`resolved: true\`, and the response has no \`allUnresolved: true\` flag — don't re-verify that with grep/Read. As of g-mesh 0.8.x, \`resolved: false\` is a narrow, accurate signal (only edges whose target is in another file g-mesh couldn't confirm — same-file edges are always \`resolved: true\`, matched against declarations actually in scope), not a blanket disclaimer, so still check: a row that shows \`resolved: false\` (check that row, not the whole list), a response with \`allUnresolved: true\` (the whole page is unconfirmed), or anything the result doesn't claim to cover at all — e.g. whether other, similarly-named symbols exist elsewhere, or a method call reached through a variable receiver (\`x.foo()\`, which produces no edge by design). Measured on real g-mesh-bench runs after the 0.8.x same-file-resolution fix: mean cost dropped ~38% and mean turns ~35% on the task this was tested on, with the remaining tool calls answering things g-mesh genuinely doesn't cover rather than re-checking it (see g-mesh's README "Reducing self-verification cost" section) — but grep/Read still earn their keep on the cases above, so don't suppress those.
- Resolving an ambiguous name (the bullet above on \`ambiguous: true\` candidates) to a specific \`symbol_id\` doesn't reopen the completeness question: a \`find_references\`/\`find_callers\`/\`find_callees\`/\`find_implementations\` page anchored by that \`symbol_id\` carries the exact same \`resolved: true\`/no-\`allUnresolved\` guarantee as an unambiguous \`symbol_name\` query. Once you've picked the right candidate, treat its result as final — don't grep/Read each returned call site file-by-file to reconfirm it's "really" that symbol and not the same-named other one, and don't run a second, broad text search across the repo to check for anything the query might have missed. Both duplicate work the tool has already resolved, the same way re-verifying a plain unambiguous result would.
- \`find_implementations\` only returns direct implementors/extenders by default — a class extending a class that implements the anchor interface won't show up in a \`hasMore: false\` page. For the whole hierarchy, re-call with \`transitive: true\` (walks the same edges transitively, up to a bounded depth, resumable via \`resume_token\`).
`;

/**
 * The kungfu-side counterpart to GMESH_CONFIGURED_CLAUDE_MD: kungfu's own
 * documented recommendation for how an agent should use it, copied verbatim
 * (not paraphrased) from github.com/denyzhirkov/kungfu's README, "Manual
 * setup (advanced / other agents)" section — so any gmesh-configured vs
 * kungfu comparison is best-practice-vs-best-practice instead of g-mesh's
 * tuned setup against kungfu with no setup guidance at all.
 *
 * Deliberately kept verbatim even though it references kungfu tools
 * (ask_context, investigate, explore_symbol, explore_file, edit_context,
 * file_history, symbol_history, change_timeline, coupling, smart_test,
 * hotspots, debug_trace, reindex, verify_change, memory_search, memory_add)
 * well outside KUNGFU_TOOLS's curated 6-tool allowlist that the
 * kungfu/kungfu-configured arms are restricted to via KUNGFU_DENIED_TOOLS.
 * The point is testing kungfu's own real recommendation as written, not a
 * version edited to match this benchmark's restriction — mismatched tool
 * references are a fair, honest side effect of the same restriction that
 * makes the kungfu arm comparable to g-mesh's 6-7 tools at all.
 */
export const KUNGFU_CONFIGURED_CLAUDE_MD = `## kungfu — context retrieval (use BEFORE Read / grep / find)

Default to kungfu; raw file reads are the fallback, not the first move — it returns
ranked, scoped packets instead of whole files. Start every task with
\`ask_context("<task>", budget: "tiny")\` and escalate the budget only if the packet
is clearly insufficient. Open a raw file only once kungfu points you at it.

Route by situation:

| Situation | First call |
|---|---|
| New task / "figure out X" | \`ask_context\` (or \`investigate\`) |
| Where is a named symbol defined/used? | \`find_symbol\` → \`explore_symbol\`, then \`callers\` / \`callees\` |
| Concept with no known name ("where does rate limiting live") | \`semantic_search\` |
| Understand a file > 50 lines | \`file_outline\` / \`explore_file\`, then a targeted Read of that range |
| About to edit a symbol | \`edit_context\` (full verbatim body + contracts — no follow-up Read) |
| "Why is it like this / what changed?" | \`file_history\` / \`symbol_history\` / \`change_timeline\` |
| Refactor touching > 1 file | \`affected\` + \`coupling\` + \`smart_test\` before editing |
| Bug with no clear file | \`hotspots\`, then \`debug_trace\` on the stack trace |

After edits: \`reindex\` the changed paths, then \`verify_change\` for the blast radius
and minimal test set. \`memory_search\` before implementing (there may already be a
decision or warning); \`memory_add\` to persist new ones — pin sparingly.

Skip kungfu only for: a one-line edit in a file already open this session; a file
< 50 lines whose exact path you know; pure shell ops; reading a config/lock file by
exact path. Otherwise, if you reach for Read / grep / find — stop and route above.
`;

/**
 * gmesh-trusted and gmesh-configured deliberately share the gmesh arm's tools
 * and MCP config; only the prompt (gmesh-trusted) or the loaded CLAUDE.md
 * (gmesh-configured) differs. Same story for kungfu-configured vs kungfu:
 * identical tools/MCP config, only the loaded CLAUDE.md (and thus cwd)
 * differs — unlike gmesh-configured, kungfu-configured doesn't fall through
 * to a shared default branch here, since plain `kungfu` isn't the default
 * case, so it needs an explicit check alongside it in all three functions
 * below.
 */
export function armMcpConfig(arm: Arm) {
  if (arm === "baseline") return buildBaselineArmConfig();
  if (arm === "kungfu" || arm === "kungfu-configured") return buildKungfuArmConfig();
  return buildGmeshArmConfig();
}

export function armTools(arm: Arm): string {
  if (arm === "baseline") return BASELINE_TOOLS;
  if (arm === "kungfu" || arm === "kungfu-configured") return KUNGFU_TOOLS;
  return GMESH_TOOLS;
}

export function armPrompt(prompt: string, arm: Arm): string {
  return arm === "gmesh-trusted" ? prompt + TRUSTED_ARM_PROMPT_SUFFIX : prompt;
}

export function armDisallowedTools(arm: Arm): string | undefined {
  return arm === "kungfu" || arm === "kungfu-configured" ? KUNGFU_DENIED_TOOLS : undefined;
}
