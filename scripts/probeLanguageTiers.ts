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

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { resolveWarm, warmGmeshIndex } from "../harness/lib/corpusResolver.js";
import { gmeshBinaryPath } from "../harness/lib/mcpConfig.js";
import { connectMcpClient } from "../harness/lib/mcpClient.js";
import type { McpClient } from "../harness/lib/mcpClient.js";
import { loadRegistry, loadTasks } from "../harness/lib/taskLoader.js";
import type { BenchTask } from "../harness/lib/types.js";

const execFileAsync = promisify(execFile);

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

// ---------------------------------------------------------------------------
// GMB-175 — per-task tier tagging.
//
// The question this section answers is different from the one LANGUAGES
// above answers. LANGUAGES asks "does the chain hold at all for this
// language" with hand-picked probes; this asks, for each task actually
// shipped in corpora/{gin,ripgrep,py-requests}/tasks.json, "does the fact
// its own oracle needs come back with the semantic tier absent, or only with
// it present". Reusing warmGmeshIndex/connectMcpClient/bodyOf from above
// rather than a second script, per GMB-175's instruction to extend this file
// if it fits.
//
// The anchor: run each task's `kind`+`target` as a real MCP call against the
// task's own pinned corpus revision (corpora/registry.json), twice —
// "semantic" (this machine's real PATH, so go/rust-analyzer/pyright-via-npx
// resolve normally) and "structural" (the same PATH with the one directory
// that resolves this language's semantic engine removed, so plugin startup
// can never find it, verified per-response rather than trusted from
// `plugins list`, which GM-341 already showed is a manifest claim, not
// evidence — see this file's own top-of-file doc comment). Each arm gets its
// own G_MESH_HOME under /tmp, so neither run can reuse a daemon the
// other arm started — the one thing that would silently invalidate the
// comparison, since a running daemon keeps whatever PATH it was first
// spawned with regardless of what a later call's env says.
//
// GM-382's own `provenance` module doc is the second, independent check that
// the structural arm actually ran structural-only rather than merely being
// asked to: it names the four tools whose completeness the semantic tier can
// change (find_references, find_callers, find_callees, find_implementations)
// and states the other four (get_file_outline, find_definition,
// get_dependencies, search_code) "answer exactly as well without it" — a
// claim from g-mesh's own source, not this script's assumption, and one this
// script checks rather than repeats: a `provenance.semanticTier === "absent"`
// block appearing on a structural-arm response to one of the four
// edge-walking tools (and never on a semantic-arm response, and never on any
// response to the other four tools) is the same kind of resolved-edge
// evidence GMB-163 used (`receiver_calls_structural=unresolved` beside a
// resolved receiver-call row) — a fact a manifest cannot fake, because
// nothing produces it except the daemon itself deciding, this call, that its
// semantic pass has not contributed.
//
// Per-task tier is NOT decided by this script — it prints both arms' full
// bodies to `<outDir>/<corpus>-<arm>.json` and a diff-oriented summary to
// stdout; a human (or the calling agent) reads each task's oracle against
// both arms' rows and decides whether the structural arm alone already
// satisfies it. Automating that last step would mean re-implementing
// lib/judge.ts's rubric grading here, which is exactly the harness behaviour
// GMB-175 was told not to smuggle in.

const SEMANTIC_ENGINE_BINARY: Record<string, string> = {
  go: "go",
  rust: "rust-analyzer",
  python: "npx", // pyright's own binary is absent on this machine; npx is its last-resort route (plugins/python/plugin.toml)
};

async function dirOfBinary(bin: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [bin]);
    return path.dirname(stdout.trim());
  } catch {
    return undefined; // already absent from PATH — nothing to strip
  }
}

/**
 * A copy of `realDir`, symlinked entry by entry, with `hideName` left out —
 * so a PATH naming this directory instead of `realDir` resolves every other
 * program in it exactly as before.
 *
 * Removing `realDir` from PATH outright (the first version of this script
 * did that) is too blunt on this machine: `go` and `node` both live in
 * `/usr/local/bin`, and `npx` and `node` both do too, so dropping the whole
 * directory to hide go/npx also hid `node` — which g-mesh's own bulk index
 * needs to spawn its (structurally irrelevant, but unconditionally attempted)
 * TypeScript plugin. That failure made the whole `g-mesh init` call exit
 * non-zero, which left the project's index short of "fully built" and made
 * the *next* daemon (the one `connectMcpClient` starts) re-walk from
 * scratch instead of reusing what `init` had already indexed — the
 * "structural" arm's first probe run answered every call with `isError:
 * true, "index is still being built"` rather than a real (if degraded)
 * answer, which would have been misread as "g-mesh answers nothing without
 * this language's semantic engine" instead of what it actually was, a race.
 */
const shadowDirCache = new Map<string, Promise<string>>();

async function shadowDirWithout(realDir: string, hideName: string): Promise<string> {
  const cacheKey = `${realDir}::${hideName}`;
  const cached = shadowDirCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const promise = (async () => {
    await fs.promises.mkdir("/tmp/gmb175", { recursive: true });
    const shadow = await fs.promises.mkdtemp(path.join("/tmp/gmb175", "shadow-"));
    const entries = await fs.promises.readdir(realDir);
    for (const entry of entries) {
      if (entry === hideName) continue;
      try {
        await fs.promises.symlink(path.join(realDir, entry), path.join(shadow, entry));
      } catch {
        // Best-effort: one unreadable/already-broken entry in realDir must not stop the rest
        // from being shadowed — a missing unrelated tool is a much smaller risk than a directory
        // this script silently failed to shadow at all.
      }
    }
    return shadow;
  })();
  shadowDirCache.set(cacheKey, promise);
  return promise;
}

/** This process's real PATH with `language`'s semantic-engine binary hidden — every other binary in the same directory still resolves. */
async function structuralPath(language: string): Promise<string> {
  const bin = SEMANTIC_ENGINE_BINARY[language];
  if (bin === undefined) throw new Error(`no known semantic-engine binary for language "${language}"`);
  const realDir = await dirOfBinary(bin);
  if (realDir === undefined) return process.env.PATH ?? ""; // already absent from PATH — nothing to shadow
  const shadow = await shadowDirWithout(realDir, bin);
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  return entries.map((entry) => (entry === realDir ? shadow : entry)).join(path.delimiter);
}

interface TieredCall {
  /** Distinguishes the two find_implementations calls (default vs transitive) in one task's output file. */
  label: string;
  tool: string;
  args: Record<string, unknown>;
}

const INDEX_BUILDING_RETRY_DELAY_MS = 3_000;
const INDEX_BUILDING_MAX_RETRIES = 60; // up to ~3 minutes, matching the tool's own "can take a minute or two" wording

function isIndexStillBuilding(result: unknown): boolean {
  const text = (result as { content?: { text?: string }[]; isError?: boolean })?.content?.[0]?.text;
  return typeof text === "string" && text.includes("index is still being built");
}

/**
 * `client.call` retried while the daemon reports its first walk still in
 * progress — the same condition the tool's own error text names ("this is
 * NOT 'no results'... retry the same call in a few seconds") and the same
 * trap a
 * real Claude Code agent can fall into (fall back to Grep instead of
 * retrying). Without this, a call issued moments after a fresh
 * G_MESH_HOME's daemon starts reads as "the tool answered nothing" and would
 * have been misattributed to whichever tier is under test in that run,
 * rather than to a index build the response is explicitly saying is not
 * done yet.
 */
async function callWithIndexRetry(
  client: McpClient,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ result: unknown; elapsedMs: number }> {
  for (let attempt = 0; ; attempt++) {
    const call = await client.call(tool, args);
    if (!isIndexStillBuilding(call.result) || attempt >= INDEX_BUILDING_MAX_RETRIES) return call;
    await new Promise((resolve) => setTimeout(resolve, INDEX_BUILDING_RETRY_DELAY_MS));
  }
}

function inferDependenciesDirection(task: BenchTask): "Incoming" | "Outgoing" {
  if (/outgoing/i.test(task.prompt)) return "Outgoing";
  return "Incoming"; // every non-outgoing get_dependencies task in these three corpora asks for importers
}

/** Maps one BenchTask onto the g-mesh MCP call(s) whose result its oracle grades. `task.kind` is already a tool name. */
function callsForTask(task: BenchTask): TieredCall[] {
  const target = task.target as { symbol: string; file: string };
  switch (task.kind) {
    case "get_file_outline":
      return [{ label: "default", tool: "get_file_outline", args: { file_path: target.file } }];
    case "find_definition":
      return [{ label: "default", tool: "find_definition", args: { symbol_name: target.symbol } }];
    case "find_references":
      return [{ label: "default", tool: "find_references", args: { symbol_name: target.symbol } }];
    case "find_callers":
      return [{ label: "default", tool: "find_callers", args: { symbol_name: target.symbol } }];
    case "find_callees":
      return [{ label: "default", tool: "find_callees", args: { symbol_name: target.symbol } }];
    case "find_implementations":
      return [
        { label: "default", tool: "find_implementations", args: { symbol_name: target.symbol } },
        { label: "transitive", tool: "find_implementations", args: { symbol_name: target.symbol, transitive: true } },
      ];
    case "get_dependencies":
      return [
        {
          label: "default",
          tool: "get_dependencies",
          args: { file_path: target.file, direction: inferDependenciesDirection(task) },
        },
      ];
    case "search_code":
      return [{ label: "default", tool: "search_code", args: { query: task.prompt } }];
    default:
      throw new Error(`task ${task.id}: no known g-mesh call for kind "${task.kind}"`);
  }
}

interface CorpusUnderTest {
  id: string;
  language: string;
}

const TAGGED_CORPORA: CorpusUnderTest[] = [
  { id: "ripgrep", language: "rust" },
  { id: "gin", language: "go" },
  { id: "py-requests", language: "python" },
];

async function runOneArm(
  corpus: CorpusUnderTest,
  arm: "semantic" | "structural",
  tasks: BenchTask[],
  outDir: string,
): Promise<void> {
  const registry = await loadRegistry();
  const entry = registry.find((e) => e.id === corpus.id);
  if (entry === undefined) throw new Error(`corpus ${corpus.id} is not in corpora/registry.json`);
  const cwd = await resolveWarm(entry);

  // Literally "/tmp", never os.tmpdir(): on this platform os.tmpdir() resolves to
  // a per-process /var/folders/.../T path 50+ bytes long on its own, and the
  // daemon's socket lives at "<G_MESH_HOME>/projects/<16 hex>/daemon.sock" —
  // 38 more bytes — which blows past Unix's ~103-byte sun_path limit before this
  // script adds a single character of its own (see g-mesh's own error for the
  // exact arithmetic; GMB-175's task brief calls this out by name).
  await fs.promises.mkdir("/tmp/gmb175", { recursive: true });
  const gmeshHome = await fs.promises.mkdtemp(path.join("/tmp/gmb175", `${corpus.id}-${arm}-`));
  const originalPath = process.env.PATH;
  const originalHome = process.env.G_MESH_HOME;
  process.env.G_MESH_HOME = gmeshHome;
  process.env.PATH = arm === "structural" ? await structuralPath(corpus.language) : (originalPath ?? "");

  console.log(
    `\n${"=".repeat(72)}\n${corpus.id.toUpperCase()} / ${arm}  cwd=${cwd}  G_MESH_HOME=${gmeshHome}\n${"=".repeat(72)}`,
  );

  const out: Record<string, unknown>[] = [];
  try {
    await warmGmeshIndex(cwd);
    const client = await connectMcpClient(cwd);
    try {
      for (const task of tasks) {
        const calls = callsForTask(task);
        for (const call of calls) {
          const label = `${task.id} :: ${call.tool}(${JSON.stringify(call.args)})`;
          try {
            const { result, elapsedMs } = await callWithIndexRetry(client, call.tool, call.args);
            const body = bodyOf(result);
            const provenance = body?.provenance;
            console.log(
              `  ${label}  [${elapsedMs.toFixed(0)}ms]  provenance=${JSON.stringify(provenance ?? null)}`,
            );
            out.push({ taskId: task.id, kind: task.kind, callLabel: call.label, tool: call.tool, args: call.args, elapsedMs, body });
          } catch (err) {
            console.log(`  ${label}  ERROR: ${(err as Error).message}`);
            out.push({ taskId: task.id, kind: task.kind, callLabel: call.label, tool: call.tool, args: call.args, error: (err as Error).message });
          }
        }
      }
    } finally {
      await client.close();
    }
  } finally {
    try {
      await execFileAsync(gmeshBinaryPath(), ["stop"], { cwd });
      console.log(`  g-mesh stop (${cwd}, G_MESH_HOME=${gmeshHome}): ok`);
    } catch (err) {
      console.warn(`  g-mesh stop failed: ${(err as Error).message}`);
    }
    process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.G_MESH_HOME;
    else process.env.G_MESH_HOME = originalHome;
  }

  const outFile = path.join(outDir, `${corpus.id}-${arm}.json`);
  await fs.promises.writeFile(outFile, JSON.stringify(out, null, 2));
  console.log(`  wrote ${outFile}`);
}

async function runTagTasks(outDir: string, corpusIdFilter?: string, armFilter?: "semantic" | "structural"): Promise<void> {
  await fs.promises.mkdir(outDir, { recursive: true });
  const corpora = TAGGED_CORPORA.filter((c) => corpusIdFilter === undefined || c.id === corpusIdFilter);
  if (corpora.length === 0) throw new Error(`no tagged corpus matches "${corpusIdFilter}"`);
  const arms: ("semantic" | "structural")[] = armFilter ? [armFilter] : ["structural", "semantic"];
  for (const corpus of corpora) {
    const tasks = await loadTasks(corpus.id);
    if (tasks.length === 0) throw new Error(`corpus ${corpus.id} has no tasks.json entries`);
    for (const arm of arms) {
      await runOneArm(corpus, arm, tasks, outDir);
    }
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--tag-tasks") {
    const rest = process.argv.slice(3);
    const outArg = rest.find((a) => a.startsWith("--out="));
    const corpusArg = rest.find((a) => a.startsWith("--corpus="));
    const armArg = rest.find((a) => a.startsWith("--arm="));
    if (outArg === undefined) {
      console.error("usage: probeLanguageTiers.ts --tag-tasks --out=<dir> [--corpus=<id>] [--arm=semantic|structural]");
      process.exitCode = 1;
      return;
    }
    const outDir = outArg.slice("--out=".length);
    const corpusId = corpusArg?.slice("--corpus=".length);
    const arm = armArg?.slice("--arm=".length) as "semantic" | "structural" | undefined;
    await runTagTasks(outDir, corpusId, arm);
    return;
  }

  const probeDir = process.argv[2];
  if (!probeDir) {
    console.error("usage: probeLanguageTiers.ts <probeDir>");
    console.error("   or: probeLanguageTiers.ts --tag-tasks --out=<dir> [--corpus=<id>] [--arm=semantic|structural]");
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
