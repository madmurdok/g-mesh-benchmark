import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadBenchConfig, resetBenchConfigCache } from "./benchConfig.js";
import {
  ARM_DEFINITIONS,
  BASELINE_TOOLS,
  EDIT_TOOLS,
  GMESH_TOOLS,
  KUNGFU_DENIED_TOOLS,
  KUNGFU_TOOLS,
  TRUSTED_ARM_PROMPT_SUFFIX,
  armDisallowedTools,
  armMcpConfig,
  armPrompt,
  armTools,
} from "./armConfig.js";
import type { McpServerConfig } from "./mcpConfig.js";
import { buildBaselineArmConfig, buildGmeshArmConfig, buildKungfuArmConfig } from "./mcpConfig.js";
import { ARM_ORDER, type Arm } from "./types.js";

/**
 * Locks the per-arm dispatch table (ARM_DEFINITIONS) to the behavior of the
 * three hand-written if/else chains it replaced.
 *
 * The `legacy*` functions below are those chains copied verbatim from the
 * pre-refactor armConfig.ts. They are the point of this file: every arm is
 * asserted equal to what the old code would have produced, so the refactor is
 * provably behavior-preserving, and any future edit to the table that changes
 * an existing arm's config has to be a deliberate edit here too.
 *
 * Run: npx tsx --test harness/lib/armConfig.test.ts
 * (no test runner is wired into package.json in this repo — see
 * reportData.test.ts/sessionReport.test.ts for the same convention.)
 */

function legacyMcpConfig(arm: Arm): McpServerConfig {
  if (arm === "baseline") return buildBaselineArmConfig();
  if (arm === "kungfu" || arm === "kungfu-configured") return buildKungfuArmConfig();
  return buildGmeshArmConfig();
}

function legacyTools(arm: Arm, opts: { allowEdit?: boolean } = {}): string {
  const base =
    arm === "baseline"
      ? BASELINE_TOOLS
      : arm === "kungfu" || arm === "kungfu-configured"
        ? KUNGFU_TOOLS
        : GMESH_TOOLS;
  return opts.allowEdit ? `${base},${EDIT_TOOLS}` : base;
}

function legacyPrompt(prompt: string, arm: Arm): string {
  return arm === "gmesh-trusted" ? prompt + TRUSTED_ARM_PROMPT_SUFFIX : prompt;
}

function legacyDisallowedTools(arm: Arm): string | undefined {
  return arm === "kungfu" || arm === "kungfu-configured" ? KUNGFU_DENIED_TOOLS : undefined;
}

/**
 * Every arm the union knows about, not just the ones the table happens to
 * list. Deliberately hand-written instead of derived from ARM_ORDER: it is a
 * frozen snapshot of the six arms the `legacy*` chains above were written for,
 * so a seventh arm has to be added here consciously (with its own expectations)
 * rather than silently graded against a default branch that never meant it.
 */
const ALL_ARMS: readonly Arm[] = [
  "gmesh",
  "baseline",
  "gmesh-trusted",
  "kungfu",
  "gmesh-configured",
  "kungfu-configured",
];

const PROMPT = "Where is exportToSvg defined?";

test("table lookup matches the pre-refactor if/else chains for every arm", () => {
  for (const arm of ALL_ARMS) {
    assert.deepEqual(armMcpConfig(arm), legacyMcpConfig(arm), `mcpConfig mismatch for ${arm}`);
    assert.equal(armTools(arm), legacyTools(arm), `tools mismatch for ${arm}`);
    assert.equal(
      armTools(arm, { allowEdit: true }),
      legacyTools(arm, { allowEdit: true }),
      `tools (allowEdit) mismatch for ${arm}`,
    );
    assert.equal(armPrompt(PROMPT, arm), legacyPrompt(PROMPT, arm), `prompt mismatch for ${arm}`);
    assert.equal(
      armDisallowedTools(arm),
      legacyDisallowedTools(arm),
      `disallowedTools mismatch for ${arm}`,
    );
  }
});

test("the table is the single place an arm is defined — no arm is missing or extra", () => {
  assert.deepEqual(Object.keys(ARM_DEFINITIONS).sort(), [...ALL_ARMS].sort());
  // ARM_ORDER (presentation) and ARM_DEFINITIONS (dispatch) must agree on the arm set;
  // an arm listed in one and not the other is the exact drift this refactor exists to prevent.
  assert.deepEqual([...ARM_ORDER].sort(), [...ALL_ARMS].sort());
});

test("gmesh-trusted and gmesh-configured share gmesh's tools and MCP config", () => {
  for (const arm of ["gmesh-trusted", "gmesh-configured"] as const) {
    assert.equal(armTools(arm), armTools("gmesh"));
    assert.deepEqual(armMcpConfig(arm), armMcpConfig("gmesh"));
    assert.equal(armDisallowedTools(arm), armDisallowedTools("gmesh"));
  }
});

test("kungfu-configured is byte-for-byte the kungfu arm's tools, deny list and MCP config", () => {
  assert.equal(armTools("kungfu-configured"), armTools("kungfu"));
  assert.equal(armDisallowedTools("kungfu-configured"), armDisallowedTools("kungfu"));
  assert.deepEqual(armMcpConfig("kungfu-configured"), armMcpConfig("kungfu"));
});

test("only gmesh-trusted gets the trust suffix; every other arm runs the prompt verbatim", () => {
  assert.equal(armPrompt(PROMPT, "gmesh-trusted"), PROMPT + TRUSTED_ARM_PROMPT_SUFFIX);
  for (const arm of ALL_ARMS.filter((a) => a !== "gmesh-trusted")) {
    assert.equal(armPrompt(PROMPT, arm), PROMPT, `${arm} must not modify the prompt`);
  }
});

test("armMcpConfig hands out a fresh object per call, not shared table state", () => {
  const first = armMcpConfig("gmesh");
  const second = armMcpConfig("gmesh");
  assert.notEqual(first, second);
  assert.deepEqual(first, second);
});

test("armMcpConfig re-reads the binary path from the environment at call time", () => {
  const original = process.env.G_MESH_BENCH_BINARY;
  try {
    process.env.G_MESH_BENCH_BINARY = "/tmp/pinned-g-mesh";
    assert.equal(armMcpConfig("gmesh").mcpServers["g-mesh"]?.command, "/tmp/pinned-g-mesh");
  } finally {
    if (original === undefined) delete process.env.G_MESH_BENCH_BINARY;
    else process.env.G_MESH_BENCH_BINARY = original;
  }
});

test("allowEdit appends EDIT_TOOLS identically for every arm", () => {
  for (const arm of ALL_ARMS) {
    assert.equal(armTools(arm, { allowEdit: true }), `${armTools(arm)},${EDIT_TOOLS}`);
    assert.equal(armTools(arm, { allowEdit: false }), armTools(arm));
  }
});

/**
 * Custom arms — the config-registered fallback each accessor above falls
 * through to when the arm is not one of ARM_DEFINITIONS' own keys.
 *
 * The fixture is loaded through benchConfig.ts's own `configPath` test hook
 * (same pattern as benchConfig.test.ts's withFixture): loadBenchConfig()
 * caches module-wide, so priming that cache from a temp file is what makes the
 * accessors — which call loadBenchConfig() with no argument — see the fixture
 * instead of the repo's real g-mesh-bench.config.json. The cache is reset on
 * both sides so no other test in this file can observe it.
 */
const FIXTURE_ARM_NAME = "mock-search";
const FIXTURE_CONFIG = {
  customArms: {
    [FIXTURE_ARM_NAME]: {
      command: "/usr/local/bin/mock-search",
      args: ["mcp", "--stdio"],
      tools: [`mcp__${FIXTURE_ARM_NAME}__find_symbol`, `mcp__${FIXTURE_ARM_NAME}__callers`],
      deniedTools: [`mcp__${FIXTURE_ARM_NAME}__reindex`],
      writesToProjectDir: true,
    },
    // Same server shape minus the optional fields — the "no deny list" case,
    // which must behave like a built-in arm that declares none.
    "mock-plain": {
      command: "mock-plain",
      args: [],
      tools: ["mcp__mock-plain__search"],
    },
  },
};

function withCustomArms(fn: () => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "gmesh-bench-armconfig-"));
  const configPath = path.join(dir, "g-mesh-bench.config.json");
  try {
    writeFileSync(configPath, JSON.stringify(FIXTURE_CONFIG));
    resetBenchConfigCache();
    loadBenchConfig(configPath);
    fn();
  } finally {
    resetBenchConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a config-registered custom arm resolves to an MCP server named after the arm", () => {
  withCustomArms(() => {
    assert.deepEqual(armMcpConfig(FIXTURE_ARM_NAME), {
      mcpServers: { [FIXTURE_ARM_NAME]: { command: "/usr/local/bin/mock-search", args: ["mcp", "--stdio"] } },
    });
    // Fresh object per call, same invariant the built-in factories hold.
    const first = armMcpConfig(FIXTURE_ARM_NAME);
    const second = armMcpConfig(FIXTURE_ARM_NAME);
    assert.notEqual(first, second);
    assert.notEqual(first.mcpServers[FIXTURE_ARM_NAME]?.args, second.mcpServers[FIXTURE_ARM_NAME]?.args);
    assert.deepEqual(first, second);
  });
});

test("a custom arm's tools are Read/Grep/Glob plus its configured list, and honor allowEdit", () => {
  withCustomArms(() => {
    const expected = `${BASELINE_TOOLS},mcp__mock-search__find_symbol,mcp__mock-search__callers`;
    assert.equal(armTools(FIXTURE_ARM_NAME), expected);
    assert.equal(armTools(FIXTURE_ARM_NAME, { allowEdit: true }), `${expected},${EDIT_TOOLS}`);
    assert.equal(armTools(FIXTURE_ARM_NAME, { allowEdit: false }), expected);
  });
});

test("a custom arm's deniedTools become the --disallowedTools list; absent means undefined", () => {
  withCustomArms(() => {
    assert.equal(armDisallowedTools(FIXTURE_ARM_NAME), "mcp__mock-search__reindex");
    assert.equal(armDisallowedTools("mock-plain"), undefined);
  });
});

test("a custom arm runs the prompt verbatim — no trusted-variant suffix", () => {
  withCustomArms(() => {
    assert.equal(armPrompt(PROMPT, FIXTURE_ARM_NAME), PROMPT);
    assert.equal(armPrompt(PROMPT, "mock-plain"), PROMPT);
  });
});

test("an arm in neither the table nor customArms throws, naming both places", () => {
  withCustomArms(() => {
    for (const accessor of [
      () => armMcpConfig("nope"),
      () => armTools("nope"),
      () => armDisallowedTools("nope"),
      () => armPrompt(PROMPT, "nope"),
    ]) {
      assert.throws(accessor, /Unknown arm "nope".*built-in arm.*customArms.*g-mesh-bench\.config\.json/s);
    }
  });
});

test("built-in arms never consult the config: they resolve with no customArms registered at all", () => {
  // The built-in table is checked first, so an empty/absent config file can't
  // change what `gmesh`/`kungfu` mean — the property that keeps every
  // historical run comparable regardless of what a local config adds.
  const dir = mkdtempSync(path.join(tmpdir(), "gmesh-bench-armconfig-empty-"));
  try {
    resetBenchConfigCache();
    loadBenchConfig(path.join(dir, "g-mesh-bench.config.json"));
    for (const arm of ALL_ARMS) {
      assert.deepEqual(armMcpConfig(arm), legacyMcpConfig(arm));
      assert.equal(armTools(arm), legacyTools(arm));
      assert.equal(armDisallowedTools(arm), legacyDisallowedTools(arm));
      assert.equal(armPrompt(PROMPT, arm), legacyPrompt(PROMPT, arm));
    }
  } finally {
    resetBenchConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
});
