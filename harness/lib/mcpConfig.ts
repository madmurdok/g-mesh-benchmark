import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The g-mesh checkout this harness measures, as a sibling of this repo
 * (README.md's documented layout).
 */
const GMESH_REPO = path.resolve(HERE, "../../../g-mesh");

/**
 * Where `cargo build --release` puts the core binary — the workspace root's
 * `target/`, not `core/target/`.
 *
 * GMB-171: this said `core/target/release/g-mesh` until now, which was right
 * until g-mesh became a cargo workspace on 2026-09-16 (GM-295). Nothing has
 * written to `core/target/` since. The path kept resolving anyway, because
 * the artifact from before the restructure was still on disk — measured on
 * one machine, `core/target/release/g-mesh` was g-mesh 2.12.0 built
 * 2026-08-27 while `target/release/g-mesh` was 3.7.0 built that morning. A
 * run started without `G_MESH_BENCH_BINARY` would have spawned a g-mesh five
 * minor versions old and recorded `gmeshVersion: "g-mesh 2.12.0"` perfectly
 * correctly, and every conclusion drawn from it would have been about a
 * build nobody meant to test. Worse on a non-TypeScript corpus: 2.12.0
 * refuses all four plugins outright (`protocol_version 2, but core expects
 * protocol version 1`), so the run shows an empty index rather than an error.
 *
 * Hence [`assertDefaultBinaryIsCurrent`]: a default that silently resolves to
 * something older than the checkout it claims to be built from is the same
 * defect class this project keeps finding — absent rendering like present.
 */
const DEFAULT_GMESH_BINARY = path.resolve(GMESH_REPO, "target/release/g-mesh");

function gmeshHeadCommittedAt(repo: string): Date | undefined {
  try {
    const iso = execFileSync("git", ["-C", repo, "log", "-1", "--format=%cI"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? undefined : at;
  } catch {
    // No git, or no checkout there. The staleness question is unanswerable
    // rather than answered "fresh", so the caller says nothing about it.
    return undefined;
  }
}

function binaryVersion(binary: string): string {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
  } catch {
    return "unknown (the binary would not run)";
  }
}

/**
 * Refuses a default that does not exist, or that predates the g-mesh checkout
 * it is supposed to have been built from.
 *
 * **Only the default.** An explicit `G_MESH_BENCH_BINARY` is never checked,
 * and that is deliberate rather than an oversight: pointing this harness at a
 * deliberately older binary is how every A/B control in this project has been
 * built (g-mesh's GM-372 and GM-378 each saved a pre-fix binary and measured
 * against it). A staleness check on the override would break the one workflow
 * that needs a stale binary on purpose.
 */
export function assertBinaryIsCurrent(binary: string, repo: string): void {
  if (!existsSync(binary)) {
    throw new Error(
      `g-mesh binary not found at ${binary}.\n` +
        `Build it with: cd ${repo} && cargo build --release -p g-mesh\n` +
        `Or point this run at one explicitly with G_MESH_BENCH_BINARY.`,
    );
  }

  const headAt = gmeshHeadCommittedAt(repo);
  if (headAt === undefined) return;

  const builtAt = statSync(binary).mtime;
  if (builtAt >= headAt) return;

  throw new Error(
    `g-mesh binary at ${binary} is older than the checkout it measures.\n` +
      `  binary:   ${binaryVersion(binary)}, built ${builtAt.toISOString()}\n` +
      `  checkout: ${repo} at HEAD committed ${headAt.toISOString()}\n` +
      `Rebuild with: cd ${repo} && cargo build --release -p g-mesh\n` +
      `A stale binary does not fail — it records its own version correctly and ` +
      `every conclusion is about a build nobody meant to test (GMB-171). ` +
      `To measure an older build on purpose, set G_MESH_BENCH_BINARY, which is never age-checked.`,
  );
}

export interface McpServerConfig {
  mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
}

export function gmeshBinaryPath(): string {
  return process.env.G_MESH_BENCH_BINARY ?? DEFAULT_GMESH_BINARY;
}

/**
 * The precondition every entry point that spawns g-mesh must assert before it
 * starts measuring. Throws with a message naming what is wrong and how to fix
 * it; returns the binary otherwise.
 *
 * Deliberately *not* folded into [`gmeshBinaryPath`]: naming a path and being
 * ready to run are different questions, and conflating them made a unit test
 * that only builds an MCP config depend on someone having run `cargo build`
 * (caught by armConfig.test.ts while this was being written).
 *
 * An explicit `G_MESH_BENCH_BINARY` is checked for existence but never for
 * age — see [`assertBinaryIsCurrent`] for why a stale override is a workflow
 * rather than a mistake.
 */
export function assertGmeshBinaryUsable(): string {
  const override = process.env.G_MESH_BENCH_BINARY;
  if (override !== undefined) {
    if (!existsSync(override)) {
      throw new Error(`G_MESH_BENCH_BINARY points at ${override}, which does not exist.`);
    }
    return override;
  }
  assertBinaryIsCurrent(DEFAULT_GMESH_BINARY, GMESH_REPO);
  return DEFAULT_GMESH_BINARY;
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
