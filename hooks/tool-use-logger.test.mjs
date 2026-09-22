// GMB-177: functional tests for the PostToolUse tool-use logger hook.
//
// These invoke the hook as a real subprocess (the way Claude Code actually
// runs a hook: JSON on stdin, TOOL_USE_LOG_PATH pointing at a log path this
// test controls), never the real $HOME/.claude/. Each test gets its own
// mkdtemp'd directory so nothing here can collide with another run or with
// a user's real log.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "tool-use-logger.mjs");

function runHook(input, logPath) {
  return spawnSync(process.execPath, [HOOK], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, TOOL_USE_LOG_PATH: logPath },
    encoding: "utf8",
  });
}

function readRecords(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function tmpLogPath() {
  const dir = mkdtempSync(path.join(tmpdir(), "gmb177-hook-test-"));
  return { dir, logPath: path.join(dir, "tool-use-log.jsonl") };
}

test("captures the required fields for a plain tool call", () => {
  const { dir, logPath } = tmpLogPath();
  const res = runHook(
    {
      session_id: "sess-1",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: { stdout: "a\nb\n", stderr: "" },
    },
    logPath,
  );
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
  const [record] = readRecords(logPath);
  assert.equal(record.session_id, "sess-1");
  assert.equal(record.tool_name, "Bash");
  assert.equal(record.error, false);
  assert.equal(typeof record.ts, "string");
  assert.equal(typeof record.response_bytes, "number");
  assert.ok(record.response_bytes > 0);
  assert.match(record.args_summary, /ls -la/);
  rmSync(dir, { recursive: true, force: true });
});

test("redacts content-bearing argument keys to a length marker, never the value - even when short", () => {
  const { dir, logPath } = tmpLogPath();
  runHook(
    {
      session_id: "sess-1",
      tool_name: "Edit",
      tool_input: { file_path: "/repo/x.ts", old_string: "a", new_string: "SECRET_TOKEN_abc123" },
      tool_response: { ok: true },
    },
    logPath,
  );
  const [record] = readRecords(logPath);
  assert.doesNotMatch(record.args_summary, /SECRET_TOKEN_abc123/);
  assert.doesNotMatch(record.args_summary, /"old_string":"a"/);
  assert.match(record.args_summary, /"new_string":"<redacted:\d+b>"/);
  assert.match(record.args_summary, /"file_path":"\/repo\/x\.ts"/); // non-content-bearing key kept
  rmSync(dir, { recursive: true, force: true });
});

test("truncates an oversized args summary instead of writing it whole", () => {
  const { dir, logPath } = tmpLogPath();
  const bigCommand = "echo " + "x".repeat(5000);
  runHook({ session_id: "s", tool_name: "Bash", tool_input: { command: bigCommand }, tool_response: {} }, logPath);
  const [record] = readRecords(logPath);
  assert.ok(record.args_summary.length < 600, `expected truncation, got length ${record.args_summary.length}`);
  assert.match(record.args_summary, /\.\.\.\(\+\d+b\)$/);
  rmSync(dir, { recursive: true, force: true });
});

test("detects errors across the isError / is_error / error response shapes", () => {
  const { dir, logPath } = tmpLogPath();
  runHook({ session_id: "s", tool_name: "T1", tool_input: {}, tool_response: { isError: true, content: [] } }, logPath);
  runHook({ session_id: "s", tool_name: "T2", tool_input: {}, tool_response: { is_error: true } }, logPath);
  runHook({ session_id: "s", tool_name: "T3", tool_input: {}, tool_response: { error: "boom" } }, logPath);
  runHook({ session_id: "s", tool_name: "T4", tool_input: {}, tool_response: { ok: true } }, logPath);
  const records = readRecords(logPath);
  assert.deepEqual(
    records.map((r) => [r.tool_name, r.error]),
    [
      ["T1", true],
      ["T2", true],
      ["T3", true],
      ["T4", false],
    ],
  );
  rmSync(dir, { recursive: true, force: true });
});

test("extracts structural markers from a g-mesh MCP response's nested content[].text, without storing the text itself", () => {
  const { dir, logPath } = tmpLogPath();
  runHook(
    {
      session_id: "s",
      tool_name: "mcp__g-mesh__find_references",
      tool_input: { symbol_name: "foo" },
      tool_response: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ resolvedBy: "id", hasMore: false, files: [{ path: "a.ts" }], results: [{ resolved: true }] }),
          },
        ],
      },
    },
    logPath,
  );
  const [record] = readRecords(logPath);
  assert.deepEqual(record.markers, { resolvedBy: "id", hasMore: false, filesPresent: true });
  // The raw response text (containing the file path "a.ts") must never appear in the log line.
  const rawLine = readFileSync(logPath, "utf8");
  assert.doesNotMatch(rawLine, /a\.ts/);
  rmSync(dir, { recursive: true, force: true });
});

test("never attaches markers for a non-g-mesh tool, even if its output happens to contain marker-shaped text", () => {
  const { dir, logPath } = tmpLogPath();
  runHook(
    {
      session_id: "s",
      tool_name: "Bash",
      tool_input: { command: "cat some-log.json" },
      tool_response: { stdout: '{"resolvedBy":"id","ambiguous":true,"hasMore":false}' },
    },
    logPath,
  );
  const [record] = readRecords(logPath);
  assert.equal(record.markers, undefined);
  rmSync(dir, { recursive: true, force: true });
});

test("malformed stdin degrades to silence: exit 0, no stdout/stderr, no record written", () => {
  const { dir, logPath } = tmpLogPath();
  const res = runHook("not json at all {{{", logPath);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
  assert.deepEqual(readRecords(logPath), []);
  rmSync(dir, { recursive: true, force: true });
});

test("unwritable log directory degrades to silence: exit 0, no throw, nothing written", { skip: process.platform === "win32" }, () => {
  const parent = mkdtempSync(path.join(tmpdir(), "gmb177-hook-test-"));
  const readonlyDir = path.join(parent, "readonly");
  mkdirSync(readonlyDir, { mode: 0o555 });
  const logPath = path.join(readonlyDir, "tool-use-log.jsonl");
  const res = runHook({ session_id: "s", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: { stdout: "hi\n" } }, logPath);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
  assert.equal(existsSync(logPath), false);
  chmodSync(readonlyDir, 0o755);
  rmSync(parent, { recursive: true, force: true });
});

test("unwritable log directory nested under a non-creatable parent chain also degrades to silence", { skip: process.platform === "win32" }, () => {
  const parent = mkdtempSync(path.join(tmpdir(), "gmb177-hook-test-"));
  const readonlyDir = path.join(parent, "readonly");
  mkdirSync(readonlyDir, { mode: 0o555 });
  const logPath = path.join(readonlyDir, "a", "b", "c", "tool-use-log.jsonl");
  const res = runHook({ session_id: "s", tool_name: "Bash", tool_input: {}, tool_response: {} }, logPath);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, "");
  assert.equal(res.stderr, "");
  assert.equal(existsSync(logPath), false);
  chmodSync(readonlyDir, 0o755);
  rmSync(parent, { recursive: true, force: true });
});
