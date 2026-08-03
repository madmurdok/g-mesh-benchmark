import assert from "node:assert/strict";
import test from "node:test";
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
