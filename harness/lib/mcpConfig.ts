import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_GMESH_BINARY = path.resolve(
  HERE,
  "../../../g-mesh/core/target/release/g-mesh",
);

export interface McpServerConfig {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

export function gmeshBinaryPath(): string {
  return process.env.G_MESH_BENCH_BINARY ?? DEFAULT_GMESH_BINARY;
}

/**
 * `daemon.coreIdleTimeoutHours`'s test-only escape hatch (`G_MESH_CORE_IDLE_MS`,
 * documented in g-mesh's `daemon::lifecycle` — "real installs never set it")
 * repurposed here as this harness's backstop against its own leaks (task #16):
 * every (task, arm, repetition) that touches a g-mesh arm now gets `g-mesh
 * stop`'d at the end of the run (see corpusResolver.ts's
 * stopTrackedGmeshDaemons), but a harness process that crashes or is killed
 * mid-sweep never reaches that teardown — its daemons would otherwise sit idle
 * for the core's real 24h default. Setting this env var on every g-mesh MCP
 * server this harness spawns means an abandoned daemon retires in minutes
 * instead of a day, with no dependency on the harness surviving to clean up
 * after itself.
 *
 * 30 minutes by default: two orders of magnitude below the 24h production
 * default, and generous enough that a legitimately busy sweep — cycling
 * through other arms/corpora between two touches of the same g-mesh cwd —
 * won't trip it, since a clean run also stops its daemons directly rather
 * than relying on this timer at all. Overridable with
 * `G_MESH_BENCH_CORE_IDLE_TIMEOUT_MS` for a fast demonstration of the
 * backstop without waiting out the real default.
 */
const DEFAULT_CORE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export function gmeshCoreIdleTimeoutMs(): number {
  const raw = process.env.G_MESH_BENCH_CORE_IDLE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_CORE_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(
      `Invalid G_MESH_BENCH_CORE_IDLE_TIMEOUT_MS value "${raw}"; expected a non-negative number of milliseconds.`,
    );
  }
  return parsed;
}

export function buildGmeshArmConfig(): McpServerConfig {
  return {
    mcpServers: {
      "g-mesh": {
        command: gmeshBinaryPath(),
        args: ["mcp-shim"],
        env: { G_MESH_CORE_IDLE_MS: String(gmeshCoreIdleTimeoutMs()) },
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
