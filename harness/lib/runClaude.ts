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
  resultText: string;
}

interface ClaudeJsonResult {
  type: string;
  subtype: string;
  is_error: boolean;
  result?: string;
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
      "--output-format",
      "json",
      "--strict-mcp-config",
      "--mcp-config",
      configPath,
      "--permission-mode",
      "bypassPermissions",
      "--tools",
      opts.tools,
      "--model",
      opts.model,
      "--max-budget-usd",
      String(opts.maxBudgetUsd),
      "--setting-sources",
      "project",
      opts.prompt,
    ];

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn("claude", args, { cwd: opts.cwd });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(out));
    });

    let parsed: ClaudeJsonResult;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { status: "error", usage: emptyUsage(), numTurns: 0, durationMs: 0, costUsd: 0, resultText: "" };
    }

    if (parsed.subtype === "error_max_budget_usd") {
      return { status: "budget_exceeded", usage: emptyUsage(), numTurns: parsed.num_turns ?? 0, durationMs: parsed.duration_ms ?? 0, costUsd: parsed.total_cost_usd ?? 0, resultText: "" };
    }
    if (parsed.is_error || parsed.subtype !== "success") {
      return { status: "error", usage: emptyUsage(), numTurns: parsed.num_turns ?? 0, durationMs: parsed.duration_ms ?? 0, costUsd: parsed.total_cost_usd ?? 0, resultText: "" };
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
      resultText: parsed.result ?? "",
    };
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
}
