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

/**
 * kungfu (github.com/denyzhirkov/kungfu) is an external, unvendored tool: its
 * own install.sh symlinks the binary onto the system PATH by design, so unlike
 * gmeshBinaryPath() there is no in-repo release build to default to. Bare
 * "kungfu" relies on PATH; override with G_MESH_BENCH_KUNGFU_BINARY for a
 * pinned/non-PATH install.
 */
export function kungfuBinaryPath(): string {
  return process.env.G_MESH_BENCH_KUNGFU_BINARY ?? "kungfu";
}

export function buildKungfuArmConfig(): McpServerConfig {
  return {
    mcpServers: {
      kungfu: {
        command: kungfuBinaryPath(),
        args: ["mcp"],
      },
    },
  };
}

/**
 * Serena (github.com/oraios/serena) is launched through `uvx` rather than a
 * pinned binary: it has no install step at all in its own documented setup —
 * `uvx --from git+…` resolves (and caches) the package straight from git on
 * first use. So unlike gmeshBinaryPath()/kungfuBinaryPath(), what has to exist
 * on PATH is the launcher, not the tool; exported so token-economy.ts can
 * preflight exactly the command this config spawns (and the same one
 * SERENA_CONFIGURED_SETTINGS_JSON's hooks shell out to).
 */
export const SERENA_LAUNCHER_COMMAND = "uvx";

/**
 * Relocated verbatim out of `g-mesh-bench.config.json`'s former
 * `customArms.serena` entry when serena/serena-configured were promoted to
 * built-in arms — same command, same argv, byte for byte, so every historical
 * `serena`-arm run stays comparable with every run made after the promotion.
 *
 * `--project-from-cwd` is what makes the arm's cwd the project Serena indexes;
 * both dashboard flags are off because the harness runs unattended and a web
 * dashboard opening a browser tab per call would be noise (and a stray
 * long-lived process) in a several-hundred-run benchmark.
 */
export function buildSerenaArmConfig(): McpServerConfig {
  return {
    mcpServers: {
      serena: {
        command: SERENA_LAUNCHER_COMMAND,
        args: [
          "--from",
          "git+https://github.com/oraios/serena",
          "serena",
          "start-mcp-server",
          "--transport",
          "stdio",
          "--project-from-cwd",
          "--enable-web-dashboard",
          "false",
          "--open-web-dashboard",
          "false",
        ],
      },
    },
  };
}
