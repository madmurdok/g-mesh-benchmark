import assert from "node:assert/strict";
import test from "node:test";
import { armMcpConfig, armTools } from "./armConfig.js";
import {
  McpArmUnavailableError,
  assertMcpHealthy,
  declaredMcpServers,
  expectedMcpToolNames,
  mcpHealthFailure,
  type McpInitState,
} from "./mcpHealth.js";

/**
 * The dead-arm guard, exercised entirely off canned init events — no CLI, no
 * API spend. Same convention as runClaude.test.ts: the pure decision function
 * is the unit under test, and the fixtures below are copied from real
 * transcripts, including the one that made this guard necessary
 * (results/transcripts/2026-08-15T10-15-33-689Z/*serena*.ndjson).
 *
 * Run: npx tsx harness/lib/mcpHealth.test.ts
 */

/** The exact init state every serena transcript of the 2026-08-14 sweep carried. */
const DEAD_SERENA: McpInitState = {
  servers: [{ name: "serena", status: "failed" }],
  tools: ["Glob", "Grep", "Read"],
};

const LIVE_GMESH: McpInitState = {
  servers: [{ name: "g-mesh", status: "connected" }],
  tools: ["Glob", "Grep", "Read", "mcp__g-mesh__find_definition", "mcp__g-mesh__find_callers"],
};

test("a declared server reported as failed is a health failure naming the arm and the server", () => {
  const failure = mcpHealthFailure("serena-configured", ["serena"], [], DEAD_SERENA);

  assert.ok(failure);
  assert.match(failure, /serena-configured/);
  assert.match(failure, /"serena" \(failed\)/);
});

test("a declared server missing from mcp_servers entirely is a failure, not a pass", () => {
  // The dangerous default: an absent entry must never read as "fine".
  const failure = mcpHealthFailure("serena-configured", ["serena"], [], { servers: [], tools: ["Read"] });

  assert.ok(failure);
  assert.match(failure, /absent from the CLI's mcp_servers list entirely/);
});

test("a connected server with its tools present is healthy", () => {
  assert.equal(mcpHealthFailure("gmesh-configured", ["g-mesh"], [], LIVE_GMESH), null);
});

test("an arm declaring no MCP servers can never fail the check", () => {
  // baseline: no servers, no mcp tools, and nothing about that is wrong.
  assert.equal(mcpHealthFailure("baseline", [], [], { servers: [], tools: ["Glob", "Grep", "Read"] }), null);
});

test("a stream with no init event is unverifiable, not dead", () => {
  // A crashed/killed process tells us nothing about its MCP wiring, and such a
  // run already fails on its own. Aborting a several-hundred-run sweep on that
  // would be a worse failure than the one being guarded against.
  assert.equal(mcpHealthFailure("serena-configured", ["serena"], [], { servers: null, tools: null }), null);
});

test("a connected server missing an explicitly expected tool is a failure", () => {
  const failure = mcpHealthFailure(
    "serena-configured",
    ["serena"],
    ["mcp__serena__find_symbol", "mcp__serena__find_implementations"],
    {
      servers: [{ name: "serena", status: "connected" }],
      tools: ["Read", "mcp__serena__find_symbol"],
    },
  );

  assert.ok(failure);
  assert.match(failure, /expected tool\(s\) absent: mcp__serena__find_implementations/);
});

test("a connected server exposing no tools at all fails even when the arm uses a wildcard", () => {
  // The g-mesh arms name their tools with `mcp__g-mesh__*`, so there is no name
  // list to check — "contributed at least one tool" is the whole check there.
  const failure = mcpHealthFailure("gmesh-configured", ["g-mesh"], [], {
    servers: [{ name: "g-mesh", status: "connected" }],
    tools: ["Glob", "Grep", "Read"],
  });

  assert.ok(failure);
  assert.match(failure, /server\(s\) exposing no tools at all: g-mesh/);
});

test("expectedMcpToolNames keeps explicit mcp tool names and drops wildcards and built-ins", () => {
  assert.deepEqual(expectedMcpToolNames("Read,Grep,Glob,mcp__g-mesh__*"), []);
  assert.deepEqual(expectedMcpToolNames("Read, mcp__serena__find_symbol ,mcp__serena__find_declaration"), [
    "mcp__serena__find_symbol",
    "mcp__serena__find_declaration",
  ]);
});

test("assertMcpHealthy throws McpArmUnavailableError with an actionable abort message", () => {
  assert.throws(
    () => assertMcpHealthy("serena-configured", ["serena"], [], DEAD_SERENA),
    (err: unknown) => {
      assert.ok(err instanceof McpArmUnavailableError);
      assert.match(err.message, /Aborting before this arm's runs can be recorded as a real result/);
      return true;
    },
  );
});

test("assertMcpHealthy is silent for a healthy arm", () => {
  assert.doesNotThrow(() => assertMcpHealthy("gmesh-configured", ["g-mesh"], [], LIVE_GMESH));
});

test("the guard's inputs come from each arm's real config, so a new arm is covered automatically", () => {
  // Guards the wiring, not the constants: whatever armConfig declares is what
  // the assertion demands, so an arm added there cannot be forgotten here.
  assert.deepEqual(declaredMcpServers(armMcpConfig("serena-configured")), ["serena"]);
  assert.deepEqual(declaredMcpServers(armMcpConfig("gmesh-configured")), ["g-mesh"]);
  assert.deepEqual(declaredMcpServers(armMcpConfig("baseline")), []);
  assert.ok(expectedMcpToolNames(armTools("serena-configured")).includes("mcp__serena__find_symbol"));

  // And the end-to-end verdict on the real serena-configured arm against the
  // real recorded init event: dead.
  assert.ok(
    mcpHealthFailure(
      "serena-configured",
      declaredMcpServers(armMcpConfig("serena-configured")),
      expectedMcpToolNames(armTools("serena-configured")),
      DEAD_SERENA,
    ),
  );
});
