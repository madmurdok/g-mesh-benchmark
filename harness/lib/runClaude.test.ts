import assert from "node:assert/strict";
import test from "node:test";
import { buildTranscriptLabel, classifyToolCall, parseStreamJson, shouldSaveTranscripts } from "./runClaude.js";

/**
 * Covers the `--output-format stream-json` parsing/tallying without spending
 * API money: parseStreamJson is a pure function of the CLI's stdout, so the
 * NDJSON fixtures below stand in for a real run.
 *
 * The fixture shape is copied from a real `claude -p --output-format
 * stream-json --verbose` invocation, including the details that matter and
 * would be easy to assume wrong: the CLI emits `system`/`user`/
 * `rate_limit_event` lines interleaved with the assistant ones, and it splits
 * a single assistant message across several lines with one content block each
 * (same `message.id`, one `thinking` block on one line, one `tool_use` block
 * on the next).
 *
 * Run: npx tsx harness/lib/runClaude.test.ts
 * (no test runner is wired into package.json in this repo — see
 * reportData.test.ts for the same convention.)
 */

function assistantLine(blocks: unknown[], messageId = "msg_1"): string {
  return JSON.stringify({ type: "assistant", message: { id: messageId, content: blocks } });
}

function toolUse(name: string, id: string): unknown {
  return { type: "tool_use", id, name, input: {} };
}

function assistantLineWithUsage(
  blocks: unknown[],
  messageId: string,
  usage: Record<string, number>,
): string {
  return JSON.stringify({ type: "assistant", message: { id: messageId, content: blocks, usage } });
}

function toolUseWithInput(name: string, id: string, input: unknown): unknown {
  return { type: "tool_use", id, name, input };
}

function toolResultLine(toolUseId: string, content: unknown): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
  });
}

function resultLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "the answer",
    session_id: "sess-1",
    num_turns: 7,
    duration_ms: 1234,
    total_cost_usd: 0.42,
    usage: { input_tokens: 5, output_tokens: 600, cache_creation_input_tokens: 4000, cache_read_input_tokens: 50000 },
    ...overrides,
  });
}

test("extracts the result event's aggregate fields from the stream's last line", () => {
  const { result } = parseStreamJson(
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      assistantLine([{ type: "text", text: "hi" }]),
      resultLine(),
      "",
    ].join("\n"),
  );

  assert.ok(result);
  assert.equal(result.num_turns, 7);
  assert.equal(result.duration_ms, 1234);
  assert.equal(result.total_cost_usd, 0.42);
  assert.equal(result.session_id, "sess-1");
  assert.equal(result.result, "the answer");
  assert.equal(result.usage.cache_read_input_tokens, 50000);
});

test("tallies search, edit and other tool calls across assistant events", () => {
  const { toolCalls } = parseStreamJson(
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "rate_limit_event" }),
      assistantLine([{ type: "thinking", thinking: "..." }], "msg_a"),
      assistantLine([toolUse("Grep", "toolu_1")], "msg_a"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
      assistantLine([toolUse("Read", "toolu_2")], "msg_b"),
      assistantLine([toolUse("mcp__g-mesh__find_callers", "toolu_3")], "msg_c"),
      assistantLine([toolUse("Edit", "toolu_4")], "msg_d"),
      assistantLine([toolUse("Write", "toolu_5")], "msg_e"),
      assistantLine([toolUse("Bash", "toolu_6")], "msg_f"),
      assistantLine([{ type: "text", text: "done" }], "msg_g"),
      resultLine(),
    ].join("\n"),
  );

  assert.deepEqual(toolCalls, { search: 3, edit: 2, other: 1 });
});

test("counts several tool_use blocks carried in one assistant event", () => {
  const { toolCalls } = parseStreamJson(
    [
      assistantLine([toolUse("Glob", "toolu_1"), toolUse("Glob", "toolu_2"), { type: "text", text: "x" }]),
      resultLine(),
    ].join("\n"),
  );

  assert.deepEqual(toolCalls, { search: 2, edit: 0, other: 0 });
});

test("de-duplicates a tool_use block that the CLI re-sends under the same id", () => {
  // Insurance against a CLI version that repeats a streamed message's blocks
  // in its final form: the same toolu_ id must never be counted twice, or
  // every tally on such a version silently doubles.
  const { toolCalls } = parseStreamJson(
    [
      assistantLine([toolUse("Read", "toolu_1")], "msg_a"),
      assistantLine([toolUse("Read", "toolu_1"), { type: "text", text: "x" }], "msg_a"),
      resultLine(),
    ].join("\n"),
  );

  assert.deepEqual(toolCalls, { search: 1, edit: 0, other: 0 });
});

test("skips an unparseable line instead of losing the whole run", () => {
  // One corrupt line used to be fatal, because the aggregate and the transcript
  // shared a single JSON blob. They no longer do.
  const { result, toolCalls } = parseStreamJson(
    [
      assistantLine([toolUse("Read", "toolu_1")]),
      "{ this is not json",
      assistantLine([toolUse("Edit", "toolu_2")]),
      resultLine(),
    ].join("\n"),
  );

  assert.ok(result);
  assert.equal(result.subtype, "success");
  assert.deepEqual(toolCalls, { search: 1, edit: 1, other: 0 });
});

test("reports no result when the stream never carried one, keeping whatever tool calls it did carry", () => {
  const { result, toolCalls } = parseStreamJson(
    [assistantLine([toolUse("Grep", "toolu_1")]), ""].join("\n"),
  );

  assert.equal(result, null);
  assert.deepEqual(toolCalls, { search: 1, edit: 0, other: 0 });
});

test("returns no result and a zero tally for empty or wholly unparseable stdout", () => {
  // `init` stays all-null rather than empty arrays: no init event means the CLI
  // never told us what connected, which mcpHealth.ts must not read as "nothing
  // was declared" (see McpInitState).
  // The two empty arrays carry the same distinction on the record side: a run
  // whose stream carried nothing is written with these fields absent, not with
  // "zero turns, nothing returned" (see token-economy.ts's TokenEconomyRun).
  const empty = {
    result: null,
    toolCalls: { search: 0, edit: 0, other: 0 },
    mcpToolCalls: 0,
    init: { servers: null, tools: null },
    perTurnUsage: [],
    toolResults: [],
  };
  assert.deepEqual(parseStreamJson(""), empty);
  assert.deepEqual(parseStreamJson("not json at all\n<html>error</html>"), empty);
});

test("reads the init event's mcp_servers and tools wherever they appear in the stream", () => {
  // Not line 0 on purpose: a serena-configured run emits its SessionStart hook
  // events first, which is exactly why the parser scans for init rather than
  // reading the first line (verified against a real transcript).
  const { init } = parseStreamJson(
    [
      JSON.stringify({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" }),
      JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["Glob", "Grep", "Read", "mcp__g-mesh__find_callers"],
        mcp_servers: [{ name: "g-mesh", status: "connected" }],
      }),
      resultLine(),
    ].join("\n"),
  );

  assert.deepEqual(init.servers, [{ name: "g-mesh", status: "connected" }]);
  assert.deepEqual(init.tools, ["Glob", "Grep", "Read", "mcp__g-mesh__find_callers"]);
});

test("surfaces a failed MCP server from the init event verbatim", () => {
  // The literal shape every serena transcript of the 2026-08-14 sweep carried.
  const { init } = parseStreamJson(
    [
      JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["Glob", "Grep", "Read"],
        mcp_servers: [{ name: "serena", status: "failed" }],
      }),
      resultLine(),
    ].join("\n"),
  );

  assert.deepEqual(init.servers, [{ name: "serena", status: "failed" }]);
  assert.deepEqual(init.tools, ["Glob", "Grep", "Read"]);
});

test("drops malformed init entries rather than failing the whole parse", () => {
  const { init, result } = parseStreamJson(
    [
      JSON.stringify({
        type: "system",
        subtype: "init",
        tools: ["Read", 42, null],
        mcp_servers: [{ name: "g-mesh", status: "connected" }, { name: "broken" }, "nonsense"],
      }),
      resultLine(),
    ].join("\n"),
  );

  assert.ok(result);
  assert.deepEqual(init.tools, ["Read"]);
  // The entry missing a `status` is dropped, which leaves the declared server
  // looking absent — mcpHealthFailure reports that as a failure, not a pass.
  assert.deepEqual(init.servers, [{ name: "g-mesh", status: "connected" }]);
});

test("counts mcp__* calls separately from, and as a subset of, the search bucket", () => {
  const { toolCalls, mcpToolCalls } = parseStreamJson(
    [
      assistantLine([toolUse("Grep", "toolu_1")]),
      assistantLine([toolUse("mcp__g-mesh__find_callers", "toolu_2")]),
      assistantLine([toolUse("mcp__g-mesh__find_references", "toolu_3")]),
      assistantLine([toolUse("Edit", "toolu_4")]),
      resultLine(),
    ].join("\n"),
  );

  assert.deepEqual(toolCalls, { search: 3, edit: 1, other: 0 });
  assert.equal(mcpToolCalls, 2);
});

test("reports zero mcp calls for a run that only ever used the built-in tools", () => {
  // The tell the 2026-08-14 sweep needed and did not have: search calls alone
  // cannot distinguish a serena arm from a baseline one, because Read/Grep/Glob
  // land in the same bucket.
  const { toolCalls, mcpToolCalls } = parseStreamJson(
    [
      assistantLine([toolUse("Grep", "toolu_1")]),
      assistantLine([toolUse("Read", "toolu_2")]),
      assistantLine([toolUse("Read", "toolu_3")]),
      resultLine(),
    ].join("\n"),
  );

  assert.deepEqual(toolCalls, { search: 3, edit: 0, other: 0 });
  assert.equal(mcpToolCalls, 0);
});

test("keeps the last result event when a stream somehow carries more than one", () => {
  const { result } = parseStreamJson(
    [resultLine({ num_turns: 1 }), resultLine({ num_turns: 9 })].join("\n"),
  );

  assert.equal(result?.num_turns, 9);
});

test("surfaces the budget-cap result subtype unchanged for runClaude to map", () => {
  const { result } = parseStreamJson(
    resultLine({ subtype: "error_max_budget_usd", is_error: true, result: undefined }),
  );

  assert.equal(result?.subtype, "error_max_budget_usd");
  assert.equal(result?.is_error, true);
});

test("classifies every MCP tool as search regardless of which server it belongs to", () => {
  // Prefix-matched on purpose: hardcoding g-mesh's and kungfu's tool names
  // would drop a newly added server's calls into `other` and make the tally
  // look broken rather than incomplete.
  assert.equal(classifyToolCall("mcp__g-mesh__find_definition"), "search");
  assert.equal(classifyToolCall("mcp__kungfu__search_symbols"), "search");
  assert.equal(classifyToolCall("mcp__some-future-server__whatever"), "search");
});

test("classifies built-in navigation tools as search and the two write tools as edit", () => {
  for (const name of ["Read", "Grep", "Glob"]) assert.equal(classifyToolCall(name), "search");
  for (const name of ["Edit", "Write"]) assert.equal(classifyToolCall(name), "edit");
});

test("classifies anything outside those sets as other rather than silently dropping it", () => {
  assert.equal(classifyToolCall("Bash"), "other");
  assert.equal(classifyToolCall("Task"), "other");
  // Not a substring match: only the `mcp__` *prefix* counts as an MCP tool.
  assert.equal(classifyToolCall("NotAnMcp__thing"), "other");
});

test("builds the corpusId-taskId-arm-repN transcript label callers pass through", () => {
  assert.equal(
    buildTranscriptLabel("task-tracker-mcp", "implement-foo", "gmesh-configured", 2),
    "task-tracker-mcp-implement-foo-gmesh-configured-rep2",
  );
});

test("shouldSaveTranscripts defaults to false when G_MESH_BENCH_SAVE_TRANSCRIPTS is unset", () => {
  const prior = process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS;
  delete process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS;
  try {
    assert.equal(shouldSaveTranscripts(), false);
  } finally {
    if (prior === undefined) delete process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS;
    else process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS = prior;
  }
});

test("shouldSaveTranscripts accepts yes/y/true and no/n/false, case- and whitespace-insensitively", () => {
  const prior = process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS;
  try {
    for (const truthy of ["yes", "Y", " true ", "TRUE"]) {
      process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS = truthy;
      assert.equal(shouldSaveTranscripts(), true, `expected "${truthy}" to be truthy`);
    }
    for (const falsy of ["no", "N", " false ", "FALSE"]) {
      process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS = falsy;
      assert.equal(shouldSaveTranscripts(), false, `expected "${falsy}" to be falsy`);
    }
  } finally {
    if (prior === undefined) delete process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS;
    else process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS = prior;
  }
});

test("shouldSaveTranscripts throws on an unrecognized value instead of silently defaulting", () => {
  const prior = process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS;
  process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS = "maybe";
  try {
    assert.throws(() => shouldSaveTranscripts(), /Invalid G_MESH_BENCH_SAVE_TRANSCRIPTS value "maybe"/);
  } finally {
    if (prior === undefined) delete process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS;
    else process.env.G_MESH_BENCH_SAVE_TRANSCRIPTS = prior;
  }
});

// ---------------------------------------------------------------------------
// Per-turn usage and tool-result sizes
//
// The 2026-08-20 sweep could not say whether g-mesh's cache-read premium was
// its schema riding in every prefix or the payloads its tools returned, because
// a run record carried one aggregate. These two fields are what settle it, so
// what they must not do is quietly mis-count.

test("records each assistant message's usage once, in stream order", () => {
  const stdout = [
    assistantLineWithUsage([{ type: "text", text: "hi" }], "msg_1", {
      input_tokens: 2,
      output_tokens: 17,
      cache_creation_input_tokens: 6541,
      cache_read_input_tokens: 6271,
    }),
    assistantLineWithUsage([{ type: "text", text: "more" }], "msg_2", {
      input_tokens: 2,
      output_tokens: 16,
      cache_creation_input_tokens: 154,
      cache_read_input_tokens: 12812,
    }),
    resultLine(),
  ].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.deepEqual(parsed.perTurnUsage, [
    { inputTokens: 2, outputTokens: 17, cacheReadTokens: 6271, cacheCreationTokens: 6541 },
    { inputTokens: 2, outputTokens: 16, cacheReadTokens: 12812, cacheCreationTokens: 154 },
  ]);
});

test("counts one usage per message when the CLI splits it across lines", () => {
  // The whole point of de-duplicating by message.id: a real stream repeats the
  // same `usage` on every line of a split message, and counting lines would
  // multiply that turn's cost by however many blocks it happened to carry.
  const usage = {
    input_tokens: 2,
    output_tokens: 2,
    cache_creation_input_tokens: 6541,
    cache_read_input_tokens: 6271,
  };
  const stdout = [
    assistantLineWithUsage([{ type: "thinking", thinking: "..." }], "msg_1", usage),
    assistantLineWithUsage([toolUse("Grep", "toolu_1")], "msg_1", usage),
    resultLine(),
  ].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.perTurnUsage.length, 1);
  assert.equal(parsed.perTurnUsage[0]?.cacheReadTokens, 6271);
});

test("sizes each tool_result and attributes it to the tool that was called", () => {
  const stdout = [
    assistantLine([toolUse("mcp__g-mesh__search_code", "toolu_1")]),
    toolResultLine("toolu_1", "a".repeat(2000)),
    assistantLine([toolUse("Grep", "toolu_2")], "msg_2"),
    toolResultLine("toolu_2", "src/a.ts:1"),
    resultLine(),
  ].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.toolResults.length, 2);
  assert.equal(parsed.toolResults[0]?.name, "mcp__g-mesh__search_code");
  assert.equal(parsed.toolResults[0]?.chars, 2002); // the two quotes JSON adds
  assert.equal(parsed.toolResults[1]?.name, "Grep");
  assert.ok((parsed.toolResults[1]?.chars ?? 0) < 20);
});

test("sizes a tool_result whose content is blocks rather than a string", () => {
  const stdout = [
    assistantLine([toolUse("mcp__g-mesh__find_references", "toolu_1")]),
    toolResultLine("toolu_1", [{ type: "text", text: "row one" }, { type: "text", text: "row two" }]),
    resultLine(),
  ].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.toolResults.length, 1);
  assert.equal(parsed.toolResults[0]?.name, "mcp__g-mesh__find_references");
  assert.ok((parsed.toolResults[0]?.chars ?? 0) > 30);
});

test("records a tool_result it cannot attribute rather than dropping it", () => {
  // A stream that lost the assistant line still says something true: a payload
  // of this size entered the conversation. Dropping it would understate the
  // very total this field exists to measure.
  const stdout = [toolResultLine("toolu_missing", "orphaned payload"), resultLine()].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.toolResults.length, 1);
  assert.equal(parsed.toolResults[0]?.name, null);
});

test("reports no turns and no tool results for a stream that carried neither", () => {
  const parsed = parseStreamJson(resultLine());

  assert.deepEqual(parsed.perTurnUsage, []);
  assert.deepEqual(parsed.toolResults, []);
});

// ---------------------------------------------------------------------------
// Call arguments and the paths a result names
//
// Both exist to answer one question the earlier fields could not: whether the
// Grep or Read that follows a g-mesh call opens a file that call had just
// returned. Without arguments the follow-up is anonymous; without paths there
// is nothing to match it against.

test("records what a tool call asked for, alongside what it returned", () => {
  const stdout = [
    assistantLine([toolUseWithInput("Read", "toolu_1", { file_path: "src/math/point.ts" })]),
    toolResultLine("toolu_1", "export const x = 1;"),
    resultLine(),
  ].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.toolResults[0]?.args, JSON.stringify({ file_path: "src/math/point.ts" }));
  assert.equal(parsed.toolResults[0]?.argsChars, JSON.stringify({ file_path: "src/math/point.ts" }).length);
});

test("truncates long arguments but keeps their real length", () => {
  // An Edit carries a whole file. Nothing measured here needs it, and a
  // truncated value must not read as a short one.
  const big = { file_path: "a.ts", new_string: "x".repeat(5000) };
  const stdout = [
    assistantLine([toolUseWithInput("Edit", "toolu_1", big)]),
    toolResultLine("toolu_1", "ok"),
    resultLine(),
  ].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.toolResults[0]?.args?.length, 200);
  assert.ok((parsed.toolResults[0]?.argsChars ?? 0) > 5000);
});

test("extracts the source paths a result names, deduplicated", () => {
  const stdout = [
    assistantLine([toolUseWithInput("mcp__g-mesh__find_references", "toolu_1", { symbol_name: "pointFrom" })]),
    toolResultLine("toolu_1", JSON.stringify({
      results: [
        { filePath: "packages/math/src/point.ts", startLine: 4 },
        { filePath: "packages/math/src/point.ts", startLine: 9 },
        { filePath: "packages/element/src/bounds.ts", startLine: 2 },
      ],
    })),
    resultLine(),
  ].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.deepEqual(parsed.toolResults[0]?.paths, [
    "packages/math/src/point.ts",
    "packages/element/src/bounds.ts",
  ]);
});

test("finds paths in a grep-shaped result too, not just a JSON one", () => {
  // One extension-driven regex has to cover find_references' filePath fields,
  // Grep's path:line: prefixes and Glob's bare list, or the match between a
  // g-mesh answer and the follow-up read only works for some tools.
  const stdout = [
    assistantLine([toolUseWithInput("Grep", "toolu_1", { pattern: "pointFrom" })]),
    toolResultLine("toolu_1", "packages/math/src/point.ts:4:export const pointFrom = ..."),
    resultLine(),
  ].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.deepEqual(parsed.toolResults[0]?.paths, ["packages/math/src/point.ts"]);
});

test("omits args and paths rather than inventing them", () => {
  // An unattributable result has no call to read arguments off, and a result
  // naming no file must not carry an empty array that reads as "searched and
  // found nothing".
  const stdout = [toolResultLine("toolu_missing", "no files here"), resultLine()].join("\n");

  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.toolResults[0]?.args, undefined);
  assert.equal(parsed.toolResults[0]?.paths, undefined);
});
