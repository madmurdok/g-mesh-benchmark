import { buildBaselineArmConfig, buildGmeshArmConfig } from "./mcpConfig.js";
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
  return arm === "baseline" ? buildBaselineArmConfig() : buildGmeshArmConfig();
}

export function armTools(arm: Arm): string {
  return arm === "baseline" ? BASELINE_TOOLS : GMESH_TOOLS;
}

export function armPrompt(prompt: string, arm: Arm): string {
  return arm === "gmesh-trusted" ? prompt + TRUSTED_ARM_PROMPT_SUFFIX : prompt;
}
