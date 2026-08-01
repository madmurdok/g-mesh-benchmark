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

/** gmesh-trusted deliberately shares the gmesh arm's tools and MCP config; only the prompt differs. */
export function armMcpConfig(arm: Arm) {
  if (arm === "baseline") return buildBaselineArmConfig();
  if (arm === "kungfu") return buildKungfuArmConfig();
  return buildGmeshArmConfig();
}

export function armTools(arm: Arm): string {
  if (arm === "baseline") return BASELINE_TOOLS;
  if (arm === "kungfu") return KUNGFU_TOOLS;
  return GMESH_TOOLS;
}

export function armPrompt(prompt: string, arm: Arm): string {
  return arm === "gmesh-trusted" ? prompt + TRUSTED_ARM_PROMPT_SUFFIX : prompt;
}

export function armDisallowedTools(arm: Arm): string | undefined {
  return arm === "kungfu" ? KUNGFU_DENIED_TOOLS : undefined;
}
