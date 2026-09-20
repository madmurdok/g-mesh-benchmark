/**
 * Answers, for a language this benchmark has never run, whether the chain
 * holds at all: plugin spawns -> daemon indexes -> tool resolves.
 *
 * Deliberately not routed through the registry. `CorpusEntry.language` is
 * typed `"ts" | "js"` (GMB-164), so a Go, Rust or Python repo cannot be
 * registered yet, and this probe has to run *before* that work to be worth
 * anything. It therefore takes directories straight off the filesystem.
 *
 * Every probe carries `expect`: a note, written by the author after reading
 * the repository's own source, of what the answer has to be. The script does
 * not grade - it prints the expectation beside the result so a reader can see
 * a wrong answer rather than a green tick. A manifest declaring
 * `semantic_pass=yes` is not evidence that a semantic pass ran; a resolved
 * edge that only a semantic pass can produce is.
 *
 * Run:
 *   G_MESH_BENCH_BINARY=/path/to/g-mesh npx tsx scripts/probeLanguageTiers.ts <probeDir>
 *
 * <probeDir> holds one checkout per language, named go-*, rs-* and py-*.
 */

import fs from "node:fs";
import path from "node:path";

import { warmGmeshIndex } from "../harness/lib/corpusResolver.js";
import { connectMcpClient } from "../harness/lib/mcpClient.js";

interface Probe {
  tool: string;
  args: Record<string, unknown>;
  /** What the repository's own source says the answer must be. */
  expect: string;
}

interface LanguageProbe {
  language: string;
  /** Directory name inside <probeDir>. */
  dir: string;
  probes: Probe[];
}

const LANGUAGES: LanguageProbe[] = [
  {
    language: "go",
    dir: "go-gin",
    probes: [
      {
        tool: "get_file_outline",
        args: { file_path: "render/render.go" },
        expect: "the Render interface plus the package's declarations",
      },
      {
        tool: "find_implementations",
        args: { symbol_name: "Render" },
        expect:
          "15 implementors under render/ - every one satisfied implicitly, with no `implements` keyword to match on",
      },
      {
        tool: "find_definition",
        args: { symbol_name: "Binding" },
        expect:
          "ambiguous: declared twice, binding/binding.go:32 and binding/binding_nomsgpack.go:30, behind build tags",
      },
      {
        tool: "find_references",
        args: { symbol_name: "ResponseWriter" },
        expect: "usages across the root package; response_writer.go:23 is the declaration",
      },
      {
        tool: "get_dependencies",
        args: { file_path: "render/render.go", direction: "Incoming" },
        expect: "the files that import the render package",
      },
      {
        tool: "search_code",
        args: { query: "write the response body as JSON" },
        expect: "render/json.go's JSON renderer near the top",
      },
    ],
  },
  {
    language: "rust",
    dir: "rs-ripgrep",
    probes: [
      {
        tool: "get_file_outline",
        args: { file_path: "crates/searcher/src/sink.rs" },
        expect: "the Sink trait and the blanket impls in the same file",
      },
      {
        tool: "find_implementations",
        args: { symbol_name: "Sink" },
        expect:
          "9 impls across 4 crates, three of them blanket/generic: `&'a mut S`, `Box<S>`, and the UTF8/Lossy/Bytes wrappers",
      },
      {
        tool: "find_definition",
        args: { symbol_name: "RegexMatcher" },
        expect:
          "ambiguous: three declarations in three crates - regex/src/matcher.rs, pcre2/src/matcher.rs, searcher/src/testutil.rs",
      },
      {
        tool: "find_implementations",
        args: { symbol_name: "Matcher" },
        expect: "the matchers above plus the blanket `impl<'a, M: Matcher> Matcher for &'a M`",
      },
      {
        tool: "get_dependencies",
        args: { file_path: "crates/searcher/src/sink.rs", direction: "Incoming" },
        expect: "crate-internal users; whether a cargo workspace is walked across crates at all",
      },
      {
        tool: "search_code",
        args: { query: "report each matching line to the caller" },
        expect: "something in searcher/src/sink.rs or the printer crates",
      },
    ],
  },
  {
    language: "python",
    dir: "py-requests",
    probes: [
      {
        tool: "get_file_outline",
        args: { file_path: "src/requests/auth.py" },
        expect: "AuthBase, HTTPBasicAuth, HTTPProxyAuth, HTTPDigestAuth",
      },
      {
        tool: "find_implementations",
        args: { symbol_name: "AuthBase" },
        expect:
          "HTTPBasicAuth and HTTPDigestAuth only - HTTPProxyAuth extends HTTPBasicAuth, so a non-transitive answer must NOT list it",
      },
      {
        tool: "find_implementations",
        args: { symbol_name: "AuthBase", transitive: true },
        expect: "the two above plus HTTPProxyAuth, which is the whole point of the flag",
      },
      {
        tool: "find_references",
        args: { symbol_name: "HTTPBasicAuth" },
        expect: "auth.py's declaration plus its uses in sessions.py / __init__.py",
      },
      {
        tool: "get_dependencies",
        args: { file_path: "src/requests/adapters.py", direction: "Incoming" },
        expect:
          "sessions.py and __init__.py; a re-export through __init__.py is the shape that tests the import walk",
      },
      {
        tool: "search_code",
        args: { query: "attach basic authentication credentials to a request" },
        expect: "auth.py's HTTPBasicAuth near the top",
      },
    ],
  },
];

/** The MCP content envelope carries the tool's JSON as text. */
function bodyOf(result: unknown): Record<string, unknown> | null {
  const text = (result as { content?: { text?: string }[] })?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * One line a human can check, rather than a dump. Keeps the fields that say
 * whether the answer is an answer: how it was resolved, whether it is
 * complete, and how many rows came back.
 */
function summarise(body: Record<string, unknown> | null, raw: unknown): string {
  if (body === null) {
    const text = (raw as { content?: { text?: string }[] })?.content?.[0]?.text;
    return `NOT JSON: ${typeof text === "string" ? text.slice(0, 300) : JSON.stringify(raw).slice(0, 300)}`;
  }
  const parts: string[] = [];
  for (const key of ["resolvedBy", "ambiguous", "allUnresolved", "truncated", "truncatedBy", "hasMore"]) {
    if (body[key] !== undefined) parts.push(`${key}=${JSON.stringify(body[key])}`);
  }
  for (const key of ["results", "candidates", "files", "symbols", "nodes"]) {
    const value = body[key];
    if (Array.isArray(value)) parts.push(`${key}=${value.length}`);
  }
  const rows = (body.results ?? body.candidates ?? body.symbols) as
    | { qualifiedName?: string; name?: string; filePath?: string; startLine?: number }[]
    | undefined;
  if (Array.isArray(rows) && rows.length > 0) {
    const shown = rows
      .slice(0, 12)
      .map((r) => `${r.qualifiedName ?? r.name ?? "?"} @ ${r.filePath ?? "?"}:${r.startLine ?? "?"}`);
    parts.push(`\n      ${shown.join("\n      ")}`);
    if (rows.length > 12) parts.push(`\n      ... ${rows.length - 12} more`);
  }
  if (parts.length === 0) return JSON.stringify(body).slice(0, 300);
  return parts.join(" ");
}

async function main(): Promise<void> {
  const probeDir = process.argv[2];
  if (!probeDir) {
    console.error("usage: probeLanguageTiers.ts <probeDir>");
    process.exitCode = 1;
    return;
  }

  for (const lang of LANGUAGES) {
    const cwd = path.resolve(probeDir, lang.dir);
    console.log(`\n${"=".repeat(72)}\n${lang.language.toUpperCase()}  ${cwd}\n${"=".repeat(72)}`);
    if (!fs.existsSync(cwd)) {
      console.log(`  ABSENT: no checkout at ${cwd} - not measured`);
      continue;
    }

    await warmGmeshIndex(cwd);

    let client;
    try {
      client = await connectMcpClient(cwd);
    } catch (err) {
      console.log(`  MCP DID NOT START: ${(err as Error).message}`);
      continue;
    }

    try {
      for (const probe of lang.probes) {
        const label = `${probe.tool}(${JSON.stringify(probe.args)})`;
        try {
          const { result, elapsedMs } = await client.call(probe.tool, probe.args);
          console.log(`\n  ${label}  [${elapsedMs.toFixed(0)}ms]`);
          console.log(`    expect: ${probe.expect}`);
          console.log(`    got:    ${summarise(bodyOf(result), result)}`);
        } catch (err) {
          console.log(`\n  ${label}`);
          console.log(`    expect: ${probe.expect}`);
          console.log(`    ERROR:  ${(err as Error).message}`);
        }
      }
    } finally {
      await client.close();
    }
  }
}

void main();
