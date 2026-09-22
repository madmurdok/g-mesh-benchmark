#!/usr/bin/env node
// GMB-177: PostToolUse hook that appends one JSONL record per tool call.
//
// Why a hook and not an MCP logging tool: see the task description (GMB-177).
// In short, a hook observes every call, can't be forgotten by the agent, costs
// the agent zero tokens, and never enters its own context.
//
// CONTRACT (Claude Code PostToolUse hook):
//   stdin  = one JSON object: {session_id, tool_name, tool_input, tool_response, ...}
//   stdout = optional JSON (we emit none); a PostToolUse hook cannot block or
//            modify the already-completed tool call, so there is nothing to
//            emit that would change behavior.
//   exit   = always 0 from this script, on every path, including failure.
//
// FAILURE MUST DEGRADE TO SILENCE. This entire script runs inside one
// try/catch. Any error - malformed stdin, unwritable log path, missing
// directory, anything - is swallowed and the process exits 0 with no stdout
// and no stderr. A measurement tool that can stop or visibly disrupt a
// session is worse than no measurement tool (see GMB-177 acceptance
// criteria). This is demonstrated in hooks/tool-use-logger.test.mjs by
// chmod-ing the log directory read-only and asserting exit 0 / no throw /
// no output.
//
// PRIVACY: read the "what we capture / what we deliberately don't" comment
// block below the function definitions before changing field selection.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_LOG_PATH = path.join(homedir(), ".claude", "tool-use-log.jsonl");
const LOG_PATH = process.env.TOOL_USE_LOG_PATH || DEFAULT_LOG_PATH;

// Argument keys whose *values* can hold whole file/code content. We never
// write these values to the log - only their byte length - regardless of
// how short they happen to be. Truncating a long value is not enough on its
// own (a short file is still a whole file), so these are redacted outright.
const CONTENT_BEARING_KEYS = new Set([
  "content",
  "new_string",
  "old_string",
  "file_text",
  "new_text",
  "old_text",
  "notebook_content",
  "source",
  "patch",
  "diff",
  "body",
  "prompt",
]);

const MAX_ARGS_SUMMARY_CHARS = 500;

function byteLength(value) {
  try {
    return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value) ?? "", "utf8");
  } catch {
    return -1;
  }
}

/** Redact content-bearing values to a length marker, keep everything else, then truncate the whole summary. */
function summarizeArgs(toolInput) {
  if (toolInput === null || typeof toolInput !== "object") {
    const s = String(toolInput ?? "");
    return s.length > MAX_ARGS_SUMMARY_CHARS ? s.slice(0, MAX_ARGS_SUMMARY_CHARS) + `...(+${s.length - MAX_ARGS_SUMMARY_CHARS}b)` : s;
  }
  const redacted = {};
  for (const [key, value] of Object.entries(toolInput)) {
    redacted[key] = CONTENT_BEARING_KEYS.has(key) ? `<redacted:${byteLength(value)}b>` : value;
  }
  let json;
  try {
    json = JSON.stringify(redacted);
  } catch {
    return "<unserializable>";
  }
  if (json.length > MAX_ARGS_SUMMARY_CHARS) {
    return json.slice(0, MAX_ARGS_SUMMARY_CHARS) + `...(+${json.length - MAX_ARGS_SUMMARY_CHARS}b)`;
  }
  return json;
}

/** Best-effort error detection across the tool_response shapes seen in practice (MCP-style {isError}, {is_error}, {error}, or a plain success/absence of any of those). */
function detectError(toolResponse) {
  if (toolResponse === null || typeof toolResponse !== "object") return false;
  if (toolResponse.isError === true || toolResponse.is_error === true) return true;
  if (toolResponse.error !== undefined && toolResponse.error !== null && toolResponse.error !== false) return true;
  if (Array.isArray(toolResponse.content) && toolResponse.content.some((c) => c && c.isError === true)) return true;
  return false;
}

// Structural markers scanned out of a g-mesh tool_response for the GMB-177
// "which routing rules fire" cut. Regex over the stringified response, not a
// JSON.parse + field read, because the response shape is the MCP server's,
// not ours, and a regex degrades to "marker absent" on any shape drift
// instead of throwing. Only booleans/short enum tokens are ever captured -
// never the matched surrounding text, and the response text itself is never
// written to the log, only scanned in memory.
const MARKER_PATTERNS = [
  ["ambiguous", /"ambiguous"\s*:\s*(true|false)/, (m) => m[1] === "true"],
  ["resolvedBy", /"resolvedBy"\s*:\s*"([A-Za-z]+)"/, (m) => m[1]],
  ["truncated", /"truncated"\s*:\s*(true|false)/, (m) => m[1] === "true"],
  ["truncatedBy", /"truncatedBy"\s*:\s*"([A-Za-z]+)"/, (m) => m[1]],
  ["allUnresolved", /"allUnresolved"\s*:\s*(true|false)/, (m) => m[1] === "true"],
  ["hasMore", /"hasMore"\s*:\s*(true|false)/, (m) => m[1] === "true"],
  ["hasUnresolvedRow", /"resolved"\s*:\s*false/, () => true],
  ["filesPresent", /"files"\s*:\s*\[/, () => true],
];

function extractGMeshMarkers(toolResponse) {
  let text;
  try {
    if (typeof toolResponse === "string") {
      text = toolResponse;
    } else if (Array.isArray(toolResponse?.content)) {
      // Standard MCP shape: {content: [{type:"text", text: "<json-as-string>"}]}.
      // Use the inner text verbatim (don't re-stringify it) so its own quotes
      // aren't double-escaped and the marker regexes still match.
      text = toolResponse.content
        .map((c) => (c && typeof c.text === "string" ? c.text : ""))
        .join("\n");
    } else {
      text = JSON.stringify(toolResponse) ?? "";
    }
  } catch {
    return undefined;
  }
  const markers = {};
  for (const [name, re, extract] of MARKER_PATTERNS) {
    const m = re.exec(text);
    if (m) markers[name] = extract(m);
  }
  return Object.keys(markers).length > 0 ? markers : undefined;
}

function readStdin() {
  // Synchronous read of fd 0. Claude Code invokes PostToolUse hooks with the
  // input JSON piped in (not a TTY), so a blocking read is safe and keeps
  // this script dependency-free and callback-free.
  return readFileSync(0, "utf8");
}

function main() {
  const raw = readStdin();
  const input = JSON.parse(raw);

  const toolName = String(input.tool_name ?? "unknown");
  const record = {
    ts: new Date().toISOString(),
    session_id: input.session_id ?? null,
    tool_name: toolName,
    args_summary: summarizeArgs(input.tool_input),
    response_bytes: byteLength(input.tool_response),
    error: detectError(input.tool_response),
  };

  if (toolName.startsWith("mcp__g-mesh__")) {
    const markers = extractGMeshMarkers(input.tool_response);
    if (markers) record.markers = markers;
  }

  mkdirSync(path.dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
}

try {
  main();
} catch {
  // Degrade to silence: no stdout, no stderr, exit 0. See file header.
}
process.exit(0);
