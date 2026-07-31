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
