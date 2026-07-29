import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { gmeshBinaryPath } from "./mcpConfig.js";

/**
 * Generous rather than the SDK's 60s default: a cold connect can block on
 * g-mesh's initial bulk-index walk, which scales with repo size (see
 * g-mesh/README.md "First run: the initial index").
 */
const CONNECT_TIMEOUT_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 5 * 60_000;

export interface McpClient {
  call(toolName: string, args: Record<string, unknown>): Promise<{ result: unknown; elapsedMs: number }>;
  close(): Promise<void>;
}

function definedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Connects to `g-mesh mcp-shim` over stdio for a given project path.
 *
 * Passes the full parent environment plus CLAUDE_PROJECT_DIR explicitly:
 * StdioClientTransport falls back to a restricted allowlist
 * (getDefaultEnvironment()) when `env` is omitted, which would silently drop
 * g-mesh-specific vars like G_MESH_JS_TS_PLUGIN_PATH.
 */
export async function connectMcpClient(projectDir: string): Promise<McpClient> {
  const transport = new StdioClientTransport({
    command: gmeshBinaryPath(),
    args: ["mcp-shim"],
    cwd: projectDir,
    env: { ...definedEnv(), CLAUDE_PROJECT_DIR: projectDir },
  });

  const client = new Client({ name: "g-mesh-bench", version: "0.1.0" });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });

  return {
    async call(toolName, args) {
      const start = performance.now();
      const result = await client.callTool(
        { name: toolName, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      return { result, elapsedMs: performance.now() - start };
    },
    async close() {
      await client.close();
    },
  };
}
