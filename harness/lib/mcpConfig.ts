import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_GMESH_BINARY = path.resolve(
  HERE,
  "../../../g-mesh/core/target/release/g-mesh",
);

export interface McpServerConfig {
  mcpServers: Record<string, { command: string; args: string[] }>;
}

export function gmeshBinaryPath(): string {
  return process.env.G_MESH_BENCH_BINARY ?? DEFAULT_GMESH_BINARY;
}

export function buildGmeshArmConfig(): McpServerConfig {
  return {
    mcpServers: {
      "g-mesh": {
        command: gmeshBinaryPath(),
        args: ["mcp-shim"],
      },
    },
  };
}

export function buildBaselineArmConfig(): McpServerConfig {
  return { mcpServers: {} };
}
