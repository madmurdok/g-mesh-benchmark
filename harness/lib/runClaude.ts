import { spawn } from "node:child_process";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpServerConfig } from "./mcpConfig.js";

export interface RunClaudeOptions {
  cwd: string;
  prompt: string;
  mcpConfig: McpServerConfig;
  tools: string;
  model: string;
  maxBudgetUsd: number;
  /**
   * Continue an existing CLI session (`--resume <id>`) instead of starting a
   * fresh one — used by session-economy.ts to chain several task prompts into
   * one conversation and observe how much of the MCP tool-schema cost
   * amortizes after the first call.
   *
   * Every other option still has to be passed identically on a resumed call:
   * each `claude -p` invocation is a new process, so --mcp-config/--tools/
   * --model are not inherited from the session being resumed.
   *
   * Omitted (the default, and what every other caller does) leaves the spawned
   * argv byte-for-byte what it was before this option existed.
   */
  resumeSessionId?: string;

  /**
   * `--disallowedTools` — a comma-separated deny list, passed through
   * verbatim to the CLI. Unlike `--tools` (`opts.tools`), which the CLI docs
   * confirm only restricts the *built-in* tool set (Read/Grep/Bash/etc.) and
   * has zero effect on `mcp__`-namespaced tools, a deny rule actually shrinks
   * what's sent to the model — the tool is removed from Claude's context
   * entirely rather than merely being blocked at permission-check time. This
   * is the mechanism `armConfig.ts`'s `armDisallowedTools()` relies on to
   * actually restrict the kungfu arm to its curated tool subset (see that
   * function's doc comment).
   *
   * Omitted (the default, and what every caller other than the kungfu arm
   * does) leaves the spawned argv byte-for-byte what it was before this
   * option existed.
   *
   * Placement in argv matters: see the comment at this option's splice site
   * below for why it must NOT go last before the trailing prompt positional
   * (unlike resumeSessionId/--resume above).
   */
  disallowedTools?: string;
}

/**
 * How many tool calls this run made, split by what the tool was *for*.
 *
 * The point of the split is to say how much of an arm's turn budget went on
 * finding things versus doing things: an `implementation` task's turn count
 * mixes navigation with editing, so comparing raw `numTurns` across arms
 * silently compares two different activities. `search` is the bucket the
 * whole benchmark is about (does g-mesh cut the navigation cost?), `edit` is
 * the work that's the same job regardless of arm.
 */
export interface ToolCallCounts {
  /** Read/Grep/Glob plus every `mcp__*` tool — g-mesh's and kungfu's alike. */
  search: number;
  /** Edit/Write — only ever granted to `implementation`-category tasks. */
  edit: number;
  /** Anything else. Expected to stay 0 today (no arm is granted tools outside the two sets above); kept so an unexpected name surfaces as a number instead of being silently dropped. */
  other: number;
}

const SEARCH_TOOL_NAMES = new Set(["Read", "Grep", "Glob"]);
const EDIT_TOOL_NAMES = new Set(["Edit", "Write"]);

/**
 * Bucket one tool name. MCP tools are matched by their `mcp__` prefix rather
 * than by name so this keeps working for any server the harness adds later —
 * hardcoding g-mesh's 7 and kungfu's 6 tool names would make a new tool
 * silently land in `other` and look like a bug in the tally.
 */
export function classifyToolCall(name: string): keyof ToolCallCounts {
  if (SEARCH_TOOL_NAMES.has(name) || name.startsWith("mcp__")) return "search";
  if (EDIT_TOOL_NAMES.has(name)) return "edit";
  return "other";
}

export interface ParsedStream {
  /** The stream's last `type: "result"` event — the aggregate the single-blob `--output-format json` used to be. null when the stream carried none (crash, killed process, garbage output). */
  result: ClaudeJsonResult | null;
  toolCalls: ToolCallCounts;
}

/**
 * Parses the CLI's `--output-format stream-json` NDJSON stdout.
 *
 * Shape (verified against the CLI this harness runs, not assumed): one JSON
 * object per line; `type: "system"`/`"user"`/`"rate_limit_event"` lines are
 * noise here, `type: "assistant"` lines each carry a `message.content` array
 * of blocks (`thinking`/`text`/`tool_use` — in practice the CLI emits one
 * block per line, splitting a single assistant message across several lines),
 * and the final `type: "result"` line carries exactly the fields the old
 * single-blob response did.
 *
 * A line that doesn't parse is skipped rather than failing the whole run: the
 * aggregate lives on its own line, so one corrupt line no longer has to cost
 * the entire measurement the way an unparseable single blob did.
 *
 * tool_use blocks are de-duplicated by their `toolu_…` id. The CLI observed
 * here emits each block exactly once, so this changes nothing today — it's
 * cheap insurance against a CLI version that re-sends a partial message's
 * blocks in its final form, which would otherwise double every tally.
 *
 * Exported and pure so the tally is testable off a canned fixture, with no
 * API spend (see runClaude.test.ts).
 */
export function parseStreamJson(stdout: string): ParsedStream {
  const toolCalls: ToolCallCounts = { search: 0, edit: 0, other: 0 };
  const seenToolUseIds = new Set<string>();
  let result: ClaudeJsonResult | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const record = event as { type?: unknown; message?: { content?: unknown } };

    // Last one wins: a well-formed stream has exactly one, but taking the last
    // keeps the old "the aggregate is whatever the CLI finished with" semantics.
    if (record.type === "result") {
      result = event as ClaudeJsonResult;
      continue;
    }
    if (record.type !== "assistant") continue;

    const content = record.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: unknown; name?: unknown; id?: unknown };
      if (b.type !== "tool_use" || typeof b.name !== "string") continue;
      if (typeof b.id === "string") {
        if (seenToolUseIds.has(b.id)) continue;
        seenToolUseIds.add(b.id);
      }
      toolCalls[classifyToolCall(b.name)]++;
    }
  }

  return { result, toolCalls };
}

export interface RunClaudeResult {
  status: "ok" | "error" | "budget_exceeded";
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  numTurns: number;
  durationMs: number;
  costUsd: number;
  /**
   * Tool calls the agent actually made, bucketed by classifyToolCall().
   * Counted straight off the event stream, so — like numTurns and unlike
   * `usage` — it is kept on the error/budget_exceeded paths too: a run that
   * blew its budget mid-navigation still really made those calls, and that is
   * exactly the run worth looking at. Zeroed only when the stream carried no
   * usable events at all.
   */
  toolCalls: ToolCallCounts;
  resultText: string;
  /**
   * The CLI's `session_id` for this call — pass it back as `resumeSessionId`
   * to continue this conversation. Populated whenever the CLI's JSON parsed at
   * all (including the error/budget_exceeded shapes, where the session still
   * exists); undefined only when the output wasn't parseable JSON.
   */
  sessionId?: string;
}

/** The `type: "result"` event that ends a stream — the same aggregate the old `--output-format json` returned as its whole body. */
export interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
  session_id?: string;
  num_turns: number;
  duration_ms: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
}

export async function runClaude(opts: RunClaudeOptions): Promise<RunClaudeResult> {
  const configDir = await mkdtemp(path.join(tmpdir(), "gmesh-bench-mcp-"));
  const configPath = path.join(configDir, "mcp-config.json");
  await writeFile(configPath, JSON.stringify(opts.mcpConfig));

  try {
    const args = [
      "-p",
      // stream-json (NDJSON), not the single `json` blob this used to ask for:
      // the blob only ever exposed the final aggregate, so per-turn tool names
      // — which tool the agent reached for, and how often — were invisible to
      // the harness. The final line of the stream carries byte-identical
      // aggregate fields, so nothing downstream loses information; see
      // parseStreamJson(). `--verbose` is required for -p to emit the
      // intermediate events at all rather than only the result line.
      "--output-format",
      "stream-json",
      "--verbose",
      "--strict-mcp-config",
      "--mcp-config",
      configPath,
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      opts.tools,
      // Spliced in only when set, right after --tools and before --model —
      // NOT at the end of argv before the trailing prompt positional (unlike
      // --resume below). --disallowedTools takes a variadic value
      // (`<tools...>` per `claude -p --help`), so if it were the last flag
      // before the bare prompt string, the CLI's arg parser greedily
      // swallows the prompt into the tools list, leaving no prompt argument
      // at all and failing every call with "Input must be provided either
      // through stdin or as a prompt argument" (confirmed empirically: this
      // exact failure mode silently errored every kungfu-arm call in this
      // fix's first verification run). Placing another flag (--model) right
      // after it bounds the variadic list correctly. A call that doesn't
      // pass this option has byte-for-byte unchanged argv.
      ...(opts.disallowedTools !== undefined ? ["--disallowedTools", opts.disallowedTools] : []),
      "--model",
      opts.model,
      "--max-budget-usd",
      String(opts.maxBudgetUsd),
      "--setting-sources",
      "project",
      // Spliced in only when resuming, immediately before the trailing prompt
      // positional, so a non-resuming call's argv is unchanged. Safe here
      // (unlike --disallowedTools above) because --resume takes a single
      // optional value (`[value]`), not a variadic list, so it can't swallow
      // the following bare prompt string.
      ...(opts.resumeSessionId !== undefined ? ["--resume", opts.resumeSessionId] : []),
      opts.prompt,
    ];

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("claude", args, { cwd: opts.cwd });
      // Decodes across chunk boundaries (StringDecoder) instead of calling
      // toString() on each Buffer independently, which mangles any multi-byte
      // character a chunk happens to split. That was survivable when stdout
      // was one JSON blob — a mangled byte broke the whole parse loudly. Under
      // stream-json it would silently corrupt one line, and a skipped line is
      // a quietly missing tool call or, on the last line, a lost aggregate.
      child.stdout.setEncoding("utf8");
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });

    const { result: parsed, toolCalls } = parseStreamJson(stdout);
    // No result event anywhere in the stream — same failure as an unparseable
    // single blob used to be, just detected per-stream instead of per-blob.
    if (parsed === null) {
      return { status: "error", usage: emptyUsage(), numTurns: 0, durationMs: 0, costUsd: 0, toolCalls, resultText: "" };
    }

    if (parsed.subtype === "error_max_budget_usd") {
      return { status: "budget_exceeded", usage: emptyUsage(), numTurns: parsed.num_turns ?? 0, durationMs: parsed.duration_ms ?? 0, costUsd: parsed.total_cost_usd ?? 0, toolCalls, resultText: "", sessionId: parsed.session_id };
    }
    if (parsed.is_error || parsed.subtype !== "success") {
      return { status: "error", usage: emptyUsage(), numTurns: parsed.num_turns ?? 0, durationMs: parsed.duration_ms ?? 0, costUsd: parsed.total_cost_usd ?? 0, toolCalls, resultText: "", sessionId: parsed.session_id };
    }

    return {
      status: "ok",
      usage: {
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens,
        cacheReadTokens: parsed.usage.cache_read_input_tokens,
        cacheCreationTokens: parsed.usage.cache_creation_input_tokens,
      },
      numTurns: parsed.num_turns,
      durationMs: parsed.duration_ms,
      costUsd: parsed.total_cost_usd,
      toolCalls,
      resultText: parsed.result ?? "",
      sessionId: parsed.session_id,
    };
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}
