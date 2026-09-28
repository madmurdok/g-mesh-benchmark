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

/**
 * Every binary a language's plugin can reach its semantic engine THROUGH -
 * not just the engine's own name. A list rather than a string because of what
 * GMB-180 measured on Rust, which is the whole reason this comment is long:
 *
 * `plugins/rust/plugin.toml` says `command = "rust-analyzer"`, and its own
 * comment spells out a second route - "a `PATH` lookup, with `rustup which
 * rust-analyzer` as the fallback". Hiding only `rust-analyzer` leaves `rustup`
 * on the shadow PATH, `rustup which rust-analyzer` answers
 * `~/.rustup/toolchains/stable-x86_64-apple-darwin/bin/rust-analyzer`, and the
 * plugin starts the engine anyway. So every GMB-175 "structural" arm for
 * ripgrep ran WITH rust-analyzer, and its finding that ripgrep needs the
 * semantic tier for 0 of 8 tasks was not a fact about Rust - it was two
 * identical arms.
 *
 * The cross-check that says which of those two it is, and that this list
 * restores: `provenance.semanticTier == "absent"` (GM-382) appears on a
 * structural-arm response to one of the four edge-walking tools and on
 * nothing else. The gin and py-requests structural arms carried it on every
 * such call; the ripgrep structural arm carried it on none, in either arm -
 * which is the daemon itself saying its Rust semantic pass had contributed.
 * `rustup` is hidden; `cargo` deliberately is not - it is a rustup proxy that
 * works by argv[0] and needs no `rustup` on PATH, and the structural
 * extractor still has to read the workspace.
 */
const SEMANTIC_ENGINE_BINARIES: Record<string, string[]> = {
  go: ["go"],
  rust: ["rust-analyzer", "rustup"],
  python: ["npx"], // pyright's own binary is absent on this machine; npx is its last-resort route (plugins/python/plugin.toml)
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

async function shadowDirWithout(realDir: string, hideNames: Set<string>): Promise<string> {
  const cacheKey = `${realDir}::${[...hideNames].sort().join(",")}`;
  const cached = shadowDirCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const promise = (async () => {
    await fs.promises.mkdir("/tmp/gmb175", { recursive: true });
    const shadow = await fs.promises.mkdtemp(path.join("/tmp/gmb175", "shadow-"));
    const entries = await fs.promises.readdir(realDir);
    for (const entry of entries) {
      if (hideNames.has(entry)) continue;
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

/**
 * This process's real PATH with every route to `language`'s semantic engine
 * hidden — each affected directory replaced by a shadow of itself, so every
 * other binary in it still resolves. Several binaries can live in one
 * directory (`rust-analyzer` and `rustup` both sit in `~/.cargo/bin`), so the
 * names are grouped per directory and each directory gets exactly one shadow.
 */
async function structuralPath(language: string): Promise<string> {
  const bins = SEMANTIC_ENGINE_BINARIES[language];
  if (bins === undefined) throw new Error(`no known semantic-engine binaries for language "${language}"`);
  const hidePerDir = new Map<string, Set<string>>();
  for (const bin of bins) {
    const realDir = await dirOfBinary(bin);
    if (realDir === undefined) continue; // already absent from PATH — nothing to shadow
    const names = hidePerDir.get(realDir) ?? new Set<string>();
    names.add(bin);
    hidePerDir.set(realDir, names);
  }
  if (hidePerDir.size === 0) return process.env.PATH ?? "";
  const shadows = new Map<string, string>();
  for (const [realDir, names] of hidePerDir) shadows.set(realDir, await shadowDirWithout(realDir, names));
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  return entries.map((entry) => shadows.get(entry) ?? entry).join(path.delimiter);
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

/**
 * One call as `runOneArm` executes it, already bound to the task (or, in
 * `--calls` mode, the draft) it is evidence for. Flattening tasks to calls
 * before the arm starts is what lets `--calls` reuse this function verbatim:
 * a draft task that does not exist in tasks.json yet has no `BenchTask` to
 * map, but it does have the one call whose two arms decide its tier.
 */
interface ArmCall {
  taskId: string;
  kind: string;
  callLabel: string;
  tool: string;
  args: Record<string, unknown>;
  /**
   * The file the task's own `target` says the anchor is declared in, when the
   * call is one of the four edge-walking tools. See `resolveAnchorArgs`.
   */
  anchorFile?: string;
}

/**
 * The four tools whose completeness the semantic tier changes, and so the four
 * whose responses carry `provenance.semanticTier` at all (GM-382's
 * `core/src/mcp/provenance.rs`, "Why the disclosure is conditional, and scoped
 * to four tools"). Also exactly the four where a bare ambiguous `symbol_name`
 * must be disambiguated before the answer means anything - see
 * `resolveAnchorArgs`.
 */
const EDGE_WALKING_TOOLS = new Set([
  "find_references",
  "find_callers",
  "find_callees",
  "find_implementations",
]);

function armCallsForTask(task: BenchTask): ArmCall[] {
  const target = task.target as { symbol?: string; file?: string };
  return callsForTask(task).map((call) => ({
    taskId: task.id,
    kind: task.kind,
    callLabel: call.label,
    tool: call.tool,
    args: call.args,
    anchorFile: EDGE_WALKING_TOOLS.has(call.tool) ? target.file : undefined,
  }));
}

/**
 * GMB-180. A bare `symbol_name` that resolves to more than one declaration
 * never reaches a graph walk at all: g-mesh answers on its disambiguation
 * rung, with `ambiguous: true` and a ranked candidate list, and its own
 * guidance tells the caller to re-query by a candidate's `id`. GMB-175 hit
 * this on two tasks and disambiguated them by hand; leaving it out of the
 * script is what let `gin-find-impl-render` be tagged `structural` on the
 * strength of an answer that is not an implementations answer at all - 19
 * declarations that merely share the name `Render`, one of which
 * (`Context.Render`) does not implement the interface and one of which is the
 * interface.
 *
 * So the probe resolves the anchor first, the same way a caller following the
 * guidance would: `find_definition(symbol_name)`, and when that comes back
 * ambiguous, the candidate declared in the task's own `target.file` - which
 * the task already states, so nothing new has to be written down per task and
 * no opaque index-internal id is pinned into `tasks.json`.
 *
 * Scoped to `EDGE_WALKING_TOOLS` deliberately: for a `find_definition` task
 * (`gin-ambiguous-binding`, `rs-ambiguous-regexmatcher`,
 * `py-ambiguous-close-session`) the ambiguity *is* the answer, and
 * disambiguating it would measure a different task than the one shipped.
 */
async function resolveAnchorArgs(
  client: McpClient,
  call: ArmCall,
): Promise<{ args: Record<string, unknown>; note: string }> {
  const symbolName = call.args.symbol_name;
  if (call.anchorFile === undefined || typeof symbolName !== "string") {
    return { args: call.args, note: "" };
  }
  const { result } = await callWithIndexRetry(client, "find_definition", { symbol_name: symbolName });
  const body = bodyOf(result);
  // Two rungs mean "this is a candidate list, not an answer": `nameAmbiguous`
  // (several declarations carry the name) and `semanticNeighbours` (nothing
  // structural matched at all, so these are the nearest declarations by
  // meaning). Both have to be re-anchored, and the second is the one that
  // bites on Rust: `Flag::name_long` is not any declaration's qualifiedName -
  // the plugin's is `flags::Flag::name_long` - so a probe that took the
  // neighbour list at face value would be reporting on whichever of 105
  // same-named declarations happened to rank first.
  const rung = body?.resolvedBy;
  if (rung !== "nameAmbiguous" && rung !== "semanticNeighbours") return { args: call.args, note: "" };
  const candidates = (body?.results ?? []) as { id?: string; filePath?: string; qualifiedName?: string }[];
  const inFile = candidates.filter((c) => c.filePath === call.anchorFile);
  // Two candidates can sit in the anchor file and mean different things, and
  // picking by rank alone silently picks a different one in each arm. In gin's
  // render/render.go the semantic index carries both `Render` (the interface
  // type) and `Render.Render` (the interface's own method declaration, which
  // only `go/types` produces); the structural index carries only the first.
  // Ranked-first therefore resolved the structural arm to the interface and
  // the semantic arm to the method - two different questions, an empty answer
  // from each, and a task that reads as `structural` because neither arm
  // answered. The exact-name preference is what keeps both arms on the
  // declaration the task actually names.
  const picked = inFile.find((c) => c.qualifiedName === symbolName) ?? inFile[0];
  if (picked?.id === undefined) {
    return {
      args: call.args,
      note: ` [${rung} (${candidates.length} candidates); NO candidate in ${call.anchorFile} - left on symbol_name]`,
    };
  }
  const { symbol_name: _dropped, ...rest } = call.args;
  return {
    args: { ...rest, symbol_id: picked.id },
    note: ` [${rung} (${candidates.length}); re-anchored on ${picked.qualifiedName ?? symbolName} @ ${call.anchorFile}]`,
  };
}

async function runOneArm(
  corpus: CorpusUnderTest,
  arm: "semantic" | "structural",
  calls: ArmCall[],
  outDir: string,
  outName: string = corpus.id,
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
      for (const call of calls) {
        try {
          const { args, note } = await resolveAnchorArgs(client, call);
          const label = `${call.taskId} :: ${call.callLabel} :: ${call.tool}(${JSON.stringify(args)})${note}`;
          const { result, elapsedMs } = await callWithIndexRetry(client, call.tool, args);
          const body = bodyOf(result);
          const provenance = body?.provenance;
          console.log(`  ${label}  [${elapsedMs.toFixed(0)}ms]  provenance=${JSON.stringify(provenance ?? null)}`);
          console.log(`      ${summarise(body, result)}`);
          out.push({ ...call, args, anchorNote: note, elapsedMs, body });
        } catch (err) {
          console.log(`  ${call.taskId} :: ${call.callLabel} :: ${call.tool}  ERROR: ${(err as Error).message}`);
          out.push({ ...call, error: (err as Error).message });
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

  const outFile = path.join(outDir, `${outName}-${arm}.json`);
  await fs.promises.writeFile(outFile, JSON.stringify(out, null, 2));
  console.log(`  wrote ${outFile}`);
}

async function runTagTasks(
  outDir: string,
  corpusIdFilter?: string,
  armFilter?: "semantic" | "structural",
  taskIdFilter?: Set<string>,
): Promise<void> {
  await fs.promises.mkdir(outDir, { recursive: true });
  const corpora = TAGGED_CORPORA.filter((c) => corpusIdFilter === undefined || c.id === corpusIdFilter);
  if (corpora.length === 0) throw new Error(`no tagged corpus matches "${corpusIdFilter}"`);
  const arms: ("semantic" | "structural")[] = armFilter ? [armFilter] : ["structural", "semantic"];
  for (const corpus of corpora) {
    const all = await loadTasks(corpus.id);
    if (all.length === 0) throw new Error(`corpus ${corpus.id} has no tasks.json entries`);
    const tasks = taskIdFilter === undefined ? all : all.filter((t) => taskIdFilter.has(t.id));
    if (tasks.length === 0) continue;
    const calls = tasks.flatMap(armCallsForTask);
    for (const arm of arms) {
      await runOneArm(corpus, arm, calls, outDir);
    }
  }
}

/**
 * GMB-180's exploration mode, and the reason it is in this file rather than a
 * scratch script: authoring a semantic-tier task is iterative (the brief's own
 * warning is that a first draft is structural by default), and the only thing
 * that settles a draft's tier is running its intended call in these exact two
 * arms. `--tag-tasks` can only run a call a task in `tasks.json` already
 * implies, so using it to *find* a shape means committing a draft first and
 * deleting it when the probe rejects it. `--calls` runs the same two arms over
 * an arbitrary list, so a draft is measured before it is written down.
 *
 * File format - a JSON array of blocks, each naming the corpus and language
 * whose shadow PATH the structural arm builds:
 *
 *   [{ "corpus": "gin", "language": "go", "out": "gin-drafts",
 *      "calls": [{ "label": "draft-1", "tool": "find_callers",
 *                  "args": { "symbol_name": "Context.Next" } }] }]
 */
interface CallsFileBlock {
  corpus: string;
  language: string;
  /** Output basename, so an exploration run does not overwrite `--tag-tasks`'s own files. */
  out?: string;
  calls: { label: string; tool: string; args: Record<string, unknown>; anchorFile?: string }[];
}

async function runCallsFile(file: string, outDir: string, armFilter?: "semantic" | "structural"): Promise<void> {
  await fs.promises.mkdir(outDir, { recursive: true });
  const blocks: CallsFileBlock[] = JSON.parse(await fs.promises.readFile(file, "utf8"));
  const arms: ("semantic" | "structural")[] = armFilter ? [armFilter] : ["structural", "semantic"];
  for (const block of blocks) {
    const calls: ArmCall[] = block.calls.map((c) => ({
      taskId: c.label,
      kind: c.tool,
      callLabel: c.label,
      tool: c.tool,
      args: c.args,
      anchorFile: c.anchorFile,
    }));
    for (const arm of arms) {
      await runOneArm({ id: block.corpus, language: block.language }, arm, calls, outDir, block.out ?? `${block.corpus}-calls`);
    }
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--calls") {
    const rest = process.argv.slice(3);
    const fileArg = rest.find((a) => a.startsWith("--file="));
    const outArg = rest.find((a) => a.startsWith("--out="));
    const armArg = rest.find((a) => a.startsWith("--arm="));
    if (fileArg === undefined || outArg === undefined) {
      console.error("usage: probeLanguageTiers.ts --calls --file=<calls.json> --out=<dir> [--arm=semantic|structural]");
      process.exitCode = 1;
      return;
    }
    await runCallsFile(
      fileArg.slice("--file=".length),
      outArg.slice("--out=".length),
      armArg?.slice("--arm=".length) as "semantic" | "structural" | undefined,
    );
    return;
  }

  if (process.argv[2] === "--tag-tasks") {
    const rest = process.argv.slice(3);
    const outArg = rest.find((a) => a.startsWith("--out="));
    const corpusArg = rest.find((a) => a.startsWith("--corpus="));
    const armArg = rest.find((a) => a.startsWith("--arm="));
    const tasksArg = rest.find((a) => a.startsWith("--tasks="));
    if (outArg === undefined) {
      console.error(
        "usage: probeLanguageTiers.ts --tag-tasks --out=<dir> [--corpus=<id>] [--arm=semantic|structural] [--tasks=<id,id>]",
      );
      process.exitCode = 1;
      return;
    }
    const taskIds = tasksArg === undefined ? undefined : new Set(tasksArg.slice("--tasks=".length).split(","));
    const outDir = outArg.slice("--out=".length);
    const corpusId = corpusArg?.slice("--corpus=".length);
    const arm = armArg?.slice("--arm=".length) as "semantic" | "structural" | undefined;
    await runTagTasks(outDir, corpusId, arm, taskIds);
    return;
  }

  const probeDir = process.argv[2];
  if (!probeDir) {
    console.error("usage: probeLanguageTiers.ts <probeDir>");
    console.error(
      "   or: probeLanguageTiers.ts --tag-tasks --out=<dir> [--corpus=<id>] [--arm=semantic|structural] [--tasks=<id,id>]",
    );
    console.error("   or: probeLanguageTiers.ts --calls --file=<calls.json> --out=<dir> [--arm=semantic|structural]");
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
