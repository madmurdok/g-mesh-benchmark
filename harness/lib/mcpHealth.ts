import type { McpServerConfig } from "./mcpConfig.js";

/**
 * Whether an arm's MCP servers actually came up — the difference between "this
 * tool did badly" and "this tool never ran".
 *
 * Exists because of the 2026-08-14 token-economy sweep (387 records, $38.75):
 * the serena-configured arm's MCP server failed to start on every single run,
 * so the agent was left holding Glob/Grep/Read — the *baseline* toolset — and
 * the harness recorded 129 rows as `status: "ok"` with a 98% oracle pass rate.
 * The sweep compared g-mesh against baseline twice and published the second
 * copy under the name "serena". Nothing in the harness said so, because nothing
 * in the harness ever looked at the init event's `mcp_servers` field.
 *
 * Everything here is pure and side-effect free so the whole guard is testable
 * off canned init events with no API spend (see mcpHealth.test.ts) — same bar
 * runClaude.ts applies to parseStreamJson()/shouldSaveTranscripts().
 */

/** The only `mcp_servers[].status` value the CLI reports for a server that actually started. */
export const MCP_CONNECTED_STATUS = "connected";

/** One entry of the CLI init event's `mcp_servers` array. */
export interface McpServerStatus {
  name: string;
  status: string;
}

/**
 * What one run's `type: "system", subtype: "init"` event said about its MCP
 * wiring — the CLI's own report of which declared servers connected and which
 * tools the model was actually handed.
 *
 * Both fields are null when the stream carried no init event at all (a crashed
 * or killed process). That is deliberately *not* treated as a dead arm below:
 * absence of evidence is not evidence of absence, and such a run already fails
 * on its own (runClaude returns `status: "error"` with no result event), so it
 * is excluded from every aggregate anyway. Aborting a several-hundred-run sweep
 * on a transient crash would be a worse failure mode than the one this guards
 * against.
 */
export interface McpInitState {
  servers: McpServerStatus[] | null;
  tools: string[] | null;
}

/** The server names an arm declares — i.e. the ones its init event must report as connected. */
export function declaredMcpServers(config: McpServerConfig): string[] {
  return Object.keys(config.mcpServers);
}

/**
 * The `mcp__server__tool` names an arm's `--tools` allow list spells out
 * explicitly.
 *
 * Wildcard entries (`mcp__g-mesh__*`, which is how the g-mesh arms are
 * configured) are dropped rather than expanded: there is nothing to compare a
 * wildcard against, so those servers fall back to the weaker
 * "at-least-one-tool-from-this-server" check in mcpHealthFailure() below.
 * Serena and kungfu name all of theirs, so those arms get the strict check.
 */
export function expectedMcpToolNames(tools: string): string[] {
  return tools
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.startsWith("mcp__") && !t.includes("*"));
}

/** `mcp__serena__find_symbol` -> `serena`; undefined for a name that isn't in that shape. */
function serverOfToolName(tool: string): string | undefined {
  const rest = tool.slice("mcp__".length);
  const sep = rest.indexOf("__");
  return sep <= 0 ? undefined : rest.slice(0, sep);
}

/**
 * Why this run's arm is not actually running the tools it claims to, or null
 * when it is (and null, too, for an arm that declares no MCP servers at all —
 * `baseline` must never trip this).
 *
 * Two independent checks, both needed:
 *
 * 1. Every declared server must appear in the init event's `mcp_servers` with
 *    `status: "connected"`. This is what the 2026-08-14 sweep failed:
 *    `[{"name": "serena", "status": "failed"}]` on every run.
 * 2. Every tool name the arm's allow list spells out must appear in the init
 *    event's `tools`. A server can connect and still expose a different tool
 *    surface than the arm was written against (a renamed or removed upstream
 *    tool), which is a quieter version of the same defect: the arm measures
 *    something other than what its config describes. For a server configured
 *    with a wildcard there is no name list to check, so it must merely
 *    contribute at least one tool.
 *
 * Returns prose rather than a boolean because the whole point is that the
 * abort message has to name the arm and the server — a bare `false` at the call
 * site would be exactly as uninformative as the silence this replaces.
 */
export function mcpHealthFailure(
  arm: string,
  declaredServers: readonly string[],
  expectedTools: readonly string[],
  init: McpInitState,
): string | null {
  if (declaredServers.length === 0) return null;
  // No init event: unverifiable, not proven dead. See McpInitState's doc.
  if (init.servers === null) return null;

  const statusByName = new Map(init.servers.map((s) => [s.name, s.status]));
  const broken = declaredServers
    .filter((name) => statusByName.get(name) !== MCP_CONNECTED_STATUS)
    .map((name) => `"${name}" (${statusByName.get(name) ?? "absent from the CLI's mcp_servers list entirely"})`);
  if (broken.length > 0) {
    return (
      `Arm "${arm}" declares MCP server(s) that did not connect: ${broken.join(", ")}. ` +
      `The agent would have run with only ${JSON.stringify(init.tools ?? [])} — i.e. the baseline toolset — ` +
      `and every row would have been recorded as a valid "${arm}" result.`
    );
  }

  const availableTools = new Set(init.tools ?? []);
  const missingNamed = expectedTools.filter((t) => !availableTools.has(t));
  // Only for servers whose tools are configured by wildcard: a named server
  // with a missing tool is already covered by `missingNamed` above, and would
  // otherwise be reported twice.
  const namedServers = new Set(expectedTools.map(serverOfToolName));
  const emptyWildcardServers = declaredServers.filter(
    (name) => !namedServers.has(name) && ![...availableTools].some((t) => t.startsWith(`mcp__${name}__`)),
  );

  if (missingNamed.length === 0 && emptyWildcardServers.length === 0) return null;
  const parts: string[] = [];
  if (missingNamed.length > 0) parts.push(`expected tool(s) absent: ${missingNamed.join(", ")}`);
  if (emptyWildcardServers.length > 0) {
    parts.push(`server(s) exposing no tools at all: ${emptyWildcardServers.join(", ")}`);
  }
  return (
    `Arm "${arm}" connected its MCP server(s), but the tool surface does not match what the arm is ` +
    `configured for — ${parts.join("; ")}. The CLI handed the agent ${JSON.stringify(init.tools ?? [])}. ` +
    `Either the server's tool names changed upstream (fix the arm's tool list in harness/lib/armConfig.ts) ` +
    `or it started in a degraded mode.`
  );
}

/**
 * Thrown by runClaude() when mcpHealthFailure() finds an arm running without
 * its tools. A named class rather than a bare Error so each entrypoint's
 * top-level handler can print the message on its own and exit non-zero, instead
 * of dumping a stack trace for what is a configuration problem, not a bug.
 */
export class McpArmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpArmUnavailableError";
  }
}

/**
 * The `main().catch(...)` handler both benchmark entrypoints install.
 *
 * A dead arm is a configuration problem, not a bug in this harness, so it gets
 * a plain message and exit code 1 rather than a stack trace. Anything else is
 * re-thrown untouched, which leaves node's own unhandled-rejection reporting —
 * and therefore every existing failure's output — exactly as it was.
 *
 * Note what does *not* happen on this path: no results file is written. A sweep
 * that discovers halfway through that one arm was never running produces no
 * rows at all, rather than a file whose reader has to know which column to
 * distrust.
 */
export function exitOnDeadArm(error: unknown): never {
  if (error instanceof McpArmUnavailableError) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
  throw error;
}

/**
 * The abort itself. Deliberately fails the whole process rather than recording
 * the run and moving on: a partially-run comparison is worth more than a
 * complete but silently wrong one, and the failure is never per-run bad luck —
 * an MCP server that can't start won't start for the next 128 runs either.
 */
export function assertMcpHealthy(
  arm: string,
  declaredServers: readonly string[],
  expectedTools: readonly string[],
  init: McpInitState,
): void {
  const failure = mcpHealthFailure(arm, declaredServers, expectedTools, init);
  if (failure === null) return;
  throw new McpArmUnavailableError(
    `${failure}\n` +
      `Aborting before this arm's runs can be recorded as a real result. Fix the server, or drop the arm ` +
      `from g-mesh-bench.config.json's arms list, then re-run.`,
  );
}
