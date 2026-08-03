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
  assert.deepEqual(parseStreamJson(""), { result: null, toolCalls: { search: 0, edit: 0, other: 0 } });
  assert.deepEqual(parseStreamJson("not json at all\n<html>error</html>"), {
    result: null,
    toolCalls: { search: 0, edit: 0, other: 0 },
  });
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
