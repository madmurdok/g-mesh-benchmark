import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT, loadBenchConfig, resetBenchConfigCache } from "./benchConfig.js";
import {
  ARM_DEFINITIONS,
  BASELINE_TOOLS,
  EDIT_TOOLS,
  GMESH_CONFIGURED_CLAUDE_MD,
  GMESH_TOOLS,
  KUNGFU_DENIED_TOOLS,
  KUNGFU_TOOLS,
  SERENA_CONFIGURED_SETTINGS_JSON,
  SERENA_DENIED_TOOLS,
  SERENA_TOOLS,
  TRUSTED_ARM_PROMPT_SUFFIX,
  armDisallowedTools,
  armMcpConfig,
  armPrompt,
  armTools,
} from "./armConfig.js";
import type { McpServerConfig } from "./mcpConfig.js";
import { buildBaselineArmConfig, buildGmeshArmConfig, buildKungfuArmConfig, buildSerenaArmConfig } from "./mcpConfig.js";
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

function isSerenaArm(arm: Arm): boolean {
  return arm === "serena" || arm === "serena-configured";
}

function legacyMcpConfig(arm: Arm): McpServerConfig {
  if (arm === "baseline") return buildBaselineArmConfig();
  if (arm === "kungfu" || arm === "kungfu-configured") return buildKungfuArmConfig();
  if (isSerenaArm(arm)) return buildSerenaArmConfig();
  return buildGmeshArmConfig();
}

function legacyTools(arm: Arm, opts: { allowEdit?: boolean } = {}): string {
  const base =
    arm === "baseline"
      ? BASELINE_TOOLS
      : arm === "kungfu" || arm === "kungfu-configured"
        ? KUNGFU_TOOLS
        : isSerenaArm(arm)
          ? SERENA_TOOLS
          : GMESH_TOOLS;
  return opts.allowEdit ? `${base},${EDIT_TOOLS}` : base;
}

function legacyPrompt(prompt: string, arm: Arm): string {
  return arm === "gmesh-trusted" ? prompt + TRUSTED_ARM_PROMPT_SUFFIX : prompt;
}

function legacyDisallowedTools(arm: Arm): string | undefined {
  if (arm === "kungfu" || arm === "kungfu-configured") return KUNGFU_DENIED_TOOLS;
  if (isSerenaArm(arm)) return SERENA_DENIED_TOOLS;
  return undefined;
}

/**
 * Every arm the union knows about, not just the ones the table happens to
 * list. Deliberately hand-written instead of derived from ARM_ORDER: it was a
 * frozen snapshot of the six arms the `legacy*` chains above were written for,
 * so a new arm has to be added here consciously (with its own expectations)
 * rather than silently graded against a default branch that never meant it.
 *
 * `serena`/`serena-configured` post-date those chains — they were a
 * `customArms` config entry, resolved through the fallback path below, until
 * `serena-configured` (which only a built-in arm can have) promoted them. So
 * their `legacy*` branches above are not a copy of anything: they are the
 * expectations written for them here, in the same shape, and the config values
 * they replaced are asserted separately by the enforcement-boundary test.
 */
const ALL_ARMS: readonly Arm[] = [
  "gmesh",
  "baseline",
  "gmesh-trusted",
  "kungfu",
  "gmesh-configured",
  // Post-dates the chains too, like the serena pair: its expectation is that it
  // is g-mesh's own config unchanged (the map is delivered through its cwd, not
  // through tools or prompt), which is exactly what legacy*'s fall-through
  // branch already returns — so it is graded here deliberately, not by accident.
  "gmesh-configured-map",
  "kungfu-configured",
  "serena",
  "serena-configured",
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

test("serena-configured is byte-for-byte the serena arm's tools, deny list and MCP config", () => {
  assert.equal(armTools("serena-configured"), armTools("serena"));
  assert.equal(armDisallowedTools("serena-configured"), armDisallowedTools("serena"));
  assert.deepEqual(armMcpConfig("serena-configured"), armMcpConfig("serena"));
});

/**
 * The exact enforcement boundary the serena/serena-configured promotion moved,
 * asserted by name rather than by list length — this *is* the fix, and a
 * future edit that re-denies either tool would otherwise silently restore the
 * bug (Serena's own MCP `instructions` field tells the agent to call
 * `initial_instructions` first, and its SessionStart hook tells it to call
 * `activate_project`; denying those makes both instructions unfollowable).
 *
 * The second half is equally load-bearing in the other direction: unblocking
 * Serena's self-configuration is *not* a general relaxation of the deny list.
 * Memory/onboarding tools stay denied, so an arm can't start writing
 * `.serena/memories/*.md` into its clone as a side effect of this change.
 */
test("serena arms allow Serena's own setup tools and still deny its memory/onboarding tools", () => {
  const denied = SERENA_DENIED_TOOLS.split(",");
  const allowed = SERENA_TOOLS.split(",");

  for (const tool of ["mcp__serena__initial_instructions", "mcp__serena__activate_project"]) {
    assert.ok(!denied.includes(tool), `${tool} must not be denied: Serena's own setup path depends on it`);
    assert.ok(allowed.includes(tool), `${tool} must be in the arm's tool list`);
  }
  for (const tool of [
    "mcp__serena__onboarding",
    "mcp__serena__write_memory",
    "mcp__serena__read_memory",
    "mcp__serena__list_memories",
  ]) {
    assert.ok(denied.includes(tool), `${tool} must stay denied`);
    assert.ok(!allowed.includes(tool), `${tool} must not be in the arm's tool list`);
  }

  // No tool may appear in both lists — a deny rule wins in the CLI, so an
  // overlap would be a tool the arm claims to offer and can never call.
  assert.deepEqual(allowed.filter((t) => denied.includes(t)), []);
  // Every arm's tool list starts with the built-ins armTools() expects (see
  // BASELINE_TOOLS); the rest of the surface is Serena's, curated.
  assert.ok(SERENA_TOOLS.startsWith(`${BASELINE_TOOLS},`));
});

test("the serena-configured settings.json wires Serena's own shipped hooks and nothing else", () => {
  // Shape-checked rather than snapshotted: what matters is that each hook
  // event maps to the matching `serena-hooks` subcommand, that Read/Grep is
  // what PreToolUse matches (the two tool names Serena's remind hook
  // classifies for the claude-code client), and that `auto-approve` — a no-op
  // under the --permission-mode bypassPermissions this harness always passes —
  // is not wired up at all.
  const { hooks } = SERENA_CONFIGURED_SETTINGS_JSON;
  const commands = Object.values(hooks)
    .flat()
    .flatMap((entry) => entry.hooks)
    .map((h) => h.command);
  assert.equal(commands.length, 3);
  for (const command of commands) {
    assert.ok(command.startsWith("uvx --from git+https://github.com/oraios/serena serena-hooks "));
    assert.ok(command.endsWith(" --client claude-code"));
  }
  assert.ok(hooks.SessionStart[0]?.hooks[0]?.command.includes(" activate "));
  assert.ok(hooks.PreToolUse[0]?.hooks[0]?.command.includes(" remind "));
  assert.ok(hooks.SessionEnd[0]?.hooks[0]?.command.includes(" cleanup "));
  assert.equal(hooks.PreToolUse[0]?.matcher, "Read|Grep");
  assert.ok(!commands.some((c) => c.includes("auto-approve")));
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

/**
 * Guards against GMESH_CONFIGURED_CLAUDE_MD (this file's hand-maintained copy
 * of g-mesh's shipped project-instruction snippet) silently drifting from the
 * real thing.
 *
 * Why this exists: g-mesh task #189 found the `symbol_id` bullet present in
 * g-mesh's README, in this repo's copy, and in the user's own
 * `~/.claude/CLAUDE.md` — but MISSING from the shipped `AGENTS_MD_SNIPPET`
 * real users receive via `g-mesh init --agent claude`. Nothing compared the
 * copies, so the drift went unnoticed. The gmesh-configured arm writes this
 * exact copy into its throwaway checkout (see corpusResolver.ts), so a
 * drifted copy means every result depending on that arm measures guidance no
 * g-mesh user actually gets — quietly invalid, the same failure class as the
 * dead serena arm (task #14), but harder to see because nothing errors.
 *
 * Locating the g-mesh checkout: same sibling-repo convention
 * gmeshBinaryPath()'s DEFAULT_GMESH_BINARY already assumes (see
 * mcpConfig.ts and README.md's "clone this repo as a sibling of g-mesh"
 * step), overridable with `G_MESH_BENCH_REPO` for a non-standard layout
 * (e.g. running from a nested worktree, where the sibling-of-ROOT default
 * does not resolve to the real checkout).
 */
const GMESH_REPO_ROOT = process.env.G_MESH_BENCH_REPO ?? path.resolve(ROOT, "..", "g-mesh");
const AGENT_INSTRUCTIONS_PATH = path.join(GMESH_REPO_ROOT, "core", "src", "cli", "agent_instructions.rs");

const AGENTS_MD_SNIPPET_START = 'pub const AGENTS_MD_SNIPPET: &str = r#"';
const AGENTS_MD_SNIPPET_END = '"#;';

/**
 * Pulls `AGENTS_MD_SNIPPET`'s literal content out of g-mesh's own source.
 * It's a Rust raw string (`r#"..."#`), which applies zero escape processing
 * to its content — so the slice this returns is already the exact text
 * `g-mesh init` writes, verbatim, no unescaping needed on this side.
 *
 * The TS side needs no unescaping either, but for a different reason:
 * GMESH_CONFIGURED_CLAUDE_MD is *imported*, not read as raw .ts source text,
 * so the JS engine has already resolved the template literal's own escapes
 * (`\`` and `\${`) into their literal characters by the time this test sees
 * it. Both sides land here as plain, already-unescaped text, which is what
 * makes a strict `===` comparison valid — extracting either side as raw
 * source text (instead of importing/parsing it properly) is the only case
 * that would need manual unescaping, and this test avoids that path entirely.
 */
function extractAgentsMdSnippet(rustSource: string, sourcePath: string): string {
  const startIdx = rustSource.indexOf(AGENTS_MD_SNIPPET_START);
  if (startIdx === -1) {
    throw new Error(
      `Could not find "${AGENTS_MD_SNIPPET_START}" in ${sourcePath} — g-mesh's own source shape changed; ` +
        `update this test's extraction to match it.`,
    );
  }
  const contentStart = startIdx + AGENTS_MD_SNIPPET_START.length;
  const endIdx = rustSource.indexOf(AGENTS_MD_SNIPPET_END, contentStart);
  if (endIdx === -1) {
    throw new Error(
      `Found AGENTS_MD_SNIPPET's opening in ${sourcePath} but not its closing '"#;' — update this test's extraction.`,
    );
  }
  return rustSource.slice(contentStart, endIdx);
}

function firstDifferenceIndex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}

/**
 * The actual guard: fails (never just warns) when the two copies diverge, and
 * the failure message both says how to fix it and names the fourth,
 * unautomated copy this test cannot check. Factored out of the test body so
 * the "fails loudly on divergence" behavior itself is unit-testable without
 * needing a real g-mesh checkout (see the two tests below).
 */
function assertSnippetsMatch(shipped: string, local: string, shippedPath: string): void {
  if (shipped === local) return;
  const diffAt = firstDifferenceIndex(shipped, local);
  assert.fail(
    `armConfig.ts's GMESH_CONFIGURED_CLAUDE_MD has drifted from g-mesh's shipped AGENTS_MD_SNIPPET ` +
      `(${shippedPath}) — first difference at character ${diffAt}.\n\n` +
      `Fix: copy AGENTS_MD_SNIPPET's content verbatim out of that file into GMESH_CONFIGURED_CLAUDE_MD in ` +
      `harness/lib/armConfig.ts (re-escape backticks and \${ for the template literal).\n\n` +
      `There is a FOURTH copy this test cannot check: the user's own ~/.claude/CLAUDE.md "Code search" ` +
      `section, synced by hand on 2026-08-15 (backup: ~/.claude/CLAUDE.md.bak-2026-08-15). Update it too ` +
      `whenever this snippet changes — nothing automates that copy.`,
  );
}

test("assertSnippetsMatch fails (not warns) on divergence, naming the fix and the unautomated CLAUDE.md copy", () => {
  assert.throws(
    () => assertSnippetsMatch("shipped text", "local text (drifted)", "/fake/path/agent_instructions.rs"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      const msg = (err as Error).message;
      assert.match(msg, /drifted/);
      assert.match(msg, /GMESH_CONFIGURED_CLAUDE_MD/);
      assert.match(msg, /harness\/lib\/armConfig\.ts/);
      assert.match(msg, /~\/\.claude\/CLAUDE\.md/);
      assert.match(msg, /2026-08-15/);
      return true;
    },
  );
});

test("assertSnippetsMatch passes silently when both sides match", () => {
  assert.doesNotThrow(() => assertSnippetsMatch("same text", "same text", "/fake/path"));
});

test("GMESH_CONFIGURED_CLAUDE_MD stays byte-for-byte in sync with g-mesh's shipped AGENTS_MD_SNIPPET", (t) => {
  if (!existsSync(AGENT_INSTRUCTIONS_PATH)) {
    t.skip(
      `No g-mesh checkout found at ${GMESH_REPO_ROOT} (expected ${AGENT_INSTRUCTIONS_PATH} to exist). ` +
        `This guard needs a sibling g-mesh checkout (README.md's documented layout) or G_MESH_BENCH_REPO ` +
        `pointed at one — SKIPPED, not passed: this run has NOT verified that armConfig.ts's copy matches ` +
        `what g-mesh actually ships.`,
    );
    return;
  }

  const rustSource = readFileSync(AGENT_INSTRUCTIONS_PATH, "utf8");
  const shipped = extractAgentsMdSnippet(rustSource, AGENT_INSTRUCTIONS_PATH);
  assertSnippetsMatch(shipped, GMESH_CONFIGURED_CLAUDE_MD, AGENT_INSTRUCTIONS_PATH);
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
