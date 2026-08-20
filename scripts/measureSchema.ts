/**
 * Measures what each arm *advertises*, as distinct from what its tools return.
 *
 * The 2026-08-20 sweep established that 93% of g-mesh's token premium on the
 * tasks it loses is cache-read rather than cache-creation, and ruled the schema
 * out as the driver using serena as a control — a schema 57% larger than
 * baseline's with baseline's per-turn read. That control was available by luck.
 * This makes the schema side a number anyone can take on demand, for any arm,
 * without waiting for a $40 sweep to produce a coincidence.
 *
 * It connects to each arm's declared MCP servers exactly as the CLI would (same
 * command, args and env `lib/mcpConfig.ts` hands the CLI), asks for `tools/list`
 * and reports the serialized size of the answer. Nothing is spent: no model is
 * involved.
 *
 * Sizes are characters, not tokens, for the reason `lib/runClaude.ts`'s
 * ToolResultSize gives — this harness has no tokenizer, and an estimate printed
 * beside measured numbers is worse than an honest unit.
 *
 * Run:
 *   npx tsx scripts/measureSchema.ts                 # every built-in arm
 *   npx tsx scripts/measureSchema.ts gmesh serena    # named arms only
 *   npx tsx scripts/measureSchema.ts --project /path # against a specific corpus
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  buildBaselineArmConfig,
  buildGmeshArmConfig,
  buildKungfuArmConfig,
  buildSerenaArmConfig,
  type McpServerConfig,
} from "../harness/lib/mcpConfig.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONNECT_TIMEOUT_MS = 5 * 60_000;

const ARMS: Record<string, () => McpServerConfig> = {
  baseline: buildBaselineArmConfig,
  gmesh: buildGmeshArmConfig,
  serena: buildSerenaArmConfig,
  kungfu: buildKungfuArmConfig,
};

interface ArmSchema {
  arm: string;
  server: string;
  tools: number;
  chars: number;
  /** Per tool, so a single verbose description is visible rather than averaged away. */
  largest: { name: string; chars: number }[];
}

function definedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

async function measureServer(
  arm: string,
  server: string,
  spec: { command: string; args: string[]; env?: Record<string, string> },
  projectDir: string,
): Promise<ArmSchema> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    cwd: projectDir,
    env: { ...definedEnv(), ...(spec.env ?? {}), CLAUDE_PROJECT_DIR: projectDir },
  });
  const client = new Client({ name: "g-mesh-bench-schema", version: "0.1.0" });
  await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  try {
    const listed = await client.listTools({}, { timeout: CONNECT_TIMEOUT_MS });
    const perTool = listed.tools.map((t) => ({
      name: t.name,
      chars: JSON.stringify(t).length,
    }));
    perTool.sort((a, b) => b.chars - a.chars);
    return {
      arm,
      server,
      tools: perTool.length,
      chars: JSON.stringify(listed.tools).length,
      largest: perTool.slice(0, 3),
    };
  } finally {
    await client.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const projectFlag = argv.indexOf("--project");
  const projectDir =
    projectFlag >= 0 ? path.resolve(argv[projectFlag + 1] ?? ".") : path.resolve(HERE, "..");
  const named = argv.filter((a, i) => !a.startsWith("--") && i !== projectFlag + 1);
  const arms = named.length > 0 ? named : Object.keys(ARMS);

  console.log(`measuring advertised tool schemas against ${projectDir}\n`);
  const rows: ArmSchema[] = [];
  for (const arm of arms) {
    const build = ARMS[arm];
    if (build === undefined) {
      console.error(`unknown arm "${arm}" — known: ${Object.keys(ARMS).join(", ")}`);
      continue;
    }
    const servers = Object.entries(build().mcpServers);
    if (servers.length === 0) {
      // Not a gap: the baseline arm declares no server, which is the number
      // every other arm is measured against.
      console.log(`${arm}: declares no MCP server (0 tools, 0 chars)`);
      continue;
    }
    for (const [server, spec] of servers) {
      try {
        rows.push(await measureServer(arm, server, spec, projectDir));
      } catch (err) {
        console.error(`${arm}/${server}: could not measure — ${(err as Error).message}`);
      }
    }
  }

  if (rows.length > 0) {
    console.log(`\n${"arm/server".padEnd(28)}${"tools".padStart(7)}${"chars".padStart(10)}`);
    for (const r of rows) {
      console.log(`${`${r.arm}/${r.server}`.padEnd(28)}${String(r.tools).padStart(7)}${String(r.chars).padStart(10)}`);
    }
    console.log("\nlargest single tool declarations:");
    for (const r of rows) {
      for (const t of r.largest) {
        console.log(`  ${`${r.arm}/${t.name}`.padEnd(44)}${String(t.chars).padStart(8)}`);
      }
    }
  }
}

await main();
