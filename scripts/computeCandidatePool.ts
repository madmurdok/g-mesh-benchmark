/**
 * computeCandidatePool.ts — offline task-authoring aid for `mode: "pool"` oracles.
 *
 * Given a corpus checkout, a symbol and the file it lives in, prints the FULL set
 * of files that reference / implement / import it, computed with the TypeScript
 * language service via ts-morph. The author pastes that list into a task's
 * `oracle.candidatePool` in `corpora/*<corpus>*\/tasks.json`.
 *
 * Why ts-morph and not g-mesh: grading g-mesh's answers against a pool that
 * g-mesh itself produced would be circular. This tool must stay independent of
 * g-mesh's index — and independent of the measured benchmark path in general:
 * it is author-invoked only, and NOTHING under `harness/` may import it.
 *
 * Usage
 *   npx tsx scripts/computeCandidatePool.ts \
 *     --corpus <path-to-checkout | registry-id> \
 *     --file <path relative to the corpus root> \
 *     [--symbol <name>] \
 *     [--mode references|implementations|importers] \
 *     [--tsconfig <path>] [--include-tests] [--include-self] [--json]
 *
 * Modes
 *   references      (default) every file with a usage/call-site of --symbol.
 *                   Drives find_references / find_callers-shaped tasks.
 *   implementations every class/interface implementing or extending --symbol,
 *                   plus TS's own "go to implementation" hits (which also cover
 *                   structural implementers). Drives find_implementations tasks.
 *   importers       every file importing the module --file (a barrel such as
 *                   packages/math/src/index.ts is the usual target). --symbol is
 *                   optional here and, when given, narrows the result to
 *                   importers that actually pull in that binding. Drives
 *                   get_dependencies-shaped tasks.
 *
 * Output
 *   stdout: one corpus-relative POSIX path per line, sorted — or a JSON array
 *           with --json, which is what you want for pasting into tasks.json.
 *   stderr: a one-line human summary. stdout stays pipe-clean.
 *
 * Workspace path aliases
 *   The pool is only correct if `@excalidraw/math`-style workspace specifiers
 *   resolve. They do, because the project is built from the corpus's own
 *   tsconfig.json (auto-detected at the corpus root), whose `paths` map every
 *   `@excalidraw/*` package onto `packages/*<pkg>*\/src/index.ts`. Do not replace
 *   `tsConfigFilePath` with a bare file glob — that silently degrades to
 *   relative-import-only resolution, which is exactly how v1's hand-picked
 *   pools undercounted the real importer set.
 */

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Node, Project } from "ts-morph";
import type { ExportedDeclarations, SourceFile } from "ts-morph";

import { resolveWarm } from "../harness/lib/corpusResolver.js";
import type { CorpusEntry } from "../harness/lib/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = path.resolve(HERE, "../corpora/registry.json");

const MODES = ["references", "implementations", "importers"] as const;
type Mode = (typeof MODES)[number];

/** ts-morph's mixins aren't exposed as `Node.is*` guards, so duck-type them. */
type ReferenceFindable = Node & { findReferencesAsNodes(): Node[] };
type ImplementationGetable = Node & {
  getImplementations(): Array<{ getSourceFile(): SourceFile }>;
};

const TEST_PATH_RE = /(^|\/)(tests?|__tests__|__mocks__|__snapshots__)\//;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;

interface Options {
  corpus: string;
  file: string;
  symbol?: string;
  mode: Mode;
  tsconfig?: string;
  includeTests: boolean;
  includeSelf: boolean;
  json: boolean;
}

const USAGE = `computeCandidatePool — compute an oracle candidatePool with ts-morph

  npx tsx scripts/computeCandidatePool.ts --corpus <path|registry-id> --file <rel-path> \\
      [--symbol <name>] [--mode references|implementations|importers] \\
      [--tsconfig <path>] [--include-tests] [--include-self] [--json]

Examples
  # every file that calls pointFrom
  ... --corpus excalidraw --symbol pointFrom --file packages/math/src/point.ts

  # every file importing the @excalidraw/math barrel (workspace alias included)
  ... --corpus excalidraw --file packages/math/src/index.ts --mode importers --json
`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseOptions(argv: string[]): Options {
  const parse = () => {
    try {
      return parseArgs({
        args: argv,
        options: {
          corpus: { type: "string" },
          file: { type: "string" },
          symbol: { type: "string" },
          mode: { type: "string", default: "references" },
          tsconfig: { type: "string" },
          "include-tests": { type: "boolean", default: false },
          "include-self": { type: "boolean", default: false },
          json: { type: "boolean", default: false },
          help: { type: "boolean", default: false },
        },
        strict: true,
      });
    } catch (err) {
      fail(`${(err as Error).message}\n\n${USAGE}`);
    }
  };

  const v = parse().values;
  if (v.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!v.corpus) fail(`--corpus is required\n\n${USAGE}`);
  if (!v.file) fail(`--file is required\n\n${USAGE}`);

  const mode = v.mode as string;
  if (!(MODES as readonly string[]).includes(mode)) {
    fail(`--mode must be one of ${MODES.join(" | ")}, got "${mode}"`);
  }
  if (mode !== "importers" && !v.symbol) {
    fail(`--symbol is required for --mode ${mode}`);
  }

  return {
    corpus: v.corpus,
    file: v.file,
    symbol: v.symbol,
    mode: mode as Mode,
    tsconfig: v.tsconfig,
    includeTests: v["include-tests"] === true,
    includeSelf: v["include-self"] === true,
    json: v.json === true,
  };
}

/** `--corpus` accepts a checkout path or an id from corpora/registry.json. */
async function resolveCorpusRoot(value: string): Promise<string> {
  const asPath = path.resolve(value);
  if (existsSync(asPath) && statSync(asPath).isDirectory()) return asPath;

  let entries: CorpusEntry[];
  try {
    entries = JSON.parse(await readFile(REGISTRY_PATH, "utf8")) as CorpusEntry[];
  } catch {
    fail(`--corpus "${value}" is not a directory and ${REGISTRY_PATH} is unreadable`);
  }
  const entry = entries.find((e) => e.id === value);
  if (!entry) {
    fail(
      `--corpus "${value}" is neither an existing directory nor a registry id ` +
        `(known ids: ${entries.map((e) => e.id).join(", ")})`,
    );
  }
  // Same warm checkout the harness uses, so pools match the pinned ref.
  return resolveWarm(entry);
}

function createProject(corpusRoot: string, tsconfigOpt: string | undefined): Project {
  const tsConfigFilePath = tsconfigOpt
    ? path.resolve(corpusRoot, tsconfigOpt)
    : path.join(corpusRoot, "tsconfig.json");

  if (!existsSync(tsConfigFilePath)) {
    fail(
      `no tsconfig at ${tsConfigFilePath}. A tsconfig is required: workspace ` +
        `path aliases (@scope/pkg -> packages/pkg/src/index.ts) only resolve ` +
        `through its "paths". Pass --tsconfig <path> if it lives elsewhere.`,
    );
  }
  return new Project({ tsConfigFilePath });
}

function toRel(corpusRoot: string, absPath: string): string {
  return path.relative(corpusRoot, absPath).split(path.sep).join("/");
}

function isTestPath(rel: string): boolean {
  return TEST_PATH_RE.test(rel) || TEST_FILE_RE.test(rel);
}

function getSourceFileOrFail(project: Project, absFile: string): SourceFile {
  const existing = project.getSourceFile(absFile);
  if (existing) return existing;
  if (!existsSync(absFile)) fail(`--file does not exist: ${absFile}`);
  console.error(
    `warning: ${absFile} is not part of the tsconfig's program; adding it ` +
      `standalone (references from files outside the program won't be found)`,
  );
  return project.addSourceFileAtPath(absFile);
}

/** All declaration nodes named `symbol` in `sf` — overloads included. */
function findDeclarations(sf: SourceFile, symbol: string): Node[] {
  const found: Node[] = [];

  const exported: ExportedDeclarations[] | undefined = sf.getExportedDeclarations().get(symbol);
  if (exported) found.push(...exported);

  if (found.length === 0) {
    for (const decl of [
      ...sf.getFunctions().filter((d) => d.getName() === symbol),
      sf.getVariableDeclaration(symbol),
      sf.getClass(symbol),
      sf.getInterface(symbol),
      sf.getTypeAlias(symbol),
      sf.getEnum(symbol),
      sf.getModule(symbol),
    ]) {
      if (decl) found.push(decl);
    }
  }

  // Last resort: any named descendant (e.g. a non-exported method).
  if (found.length === 0) {
    sf.forEachDescendant((node) => {
      if (Node.hasName(node) && node.getName() === symbol) found.push(node);
    });
  }

  const seen = new Set<string>();
  return found.filter((node) => {
    const key = `${node.getSourceFile().getFilePath()}:${node.getPos()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectReferenceNodes(decls: Node[]): Node[] {
  const nodes: Node[] = [];
  for (const decl of decls) {
    const candidate = decl as Partial<ReferenceFindable>;
    if (typeof candidate.findReferencesAsNodes !== "function") continue;
    nodes.push(...(decl as ReferenceFindable).findReferencesAsNodes());
  }
  return nodes;
}

function computeReferences(sf: SourceFile, symbol: string): Set<string> {
  const decls = findDeclarations(sf, symbol);
  if (decls.length === 0) fail(`symbol "${symbol}" not found in ${sf.getFilePath()}`);

  const files = new Set<string>();
  for (const node of collectReferenceNodes(decls)) {
    files.add(node.getSourceFile().getFilePath());
  }
  return files;
}

/**
 * Union of two independent signals: TS's "go to implementation" (also catches
 * structural implementers) and a heritage-clause scan over every reference
 * (`class X implements I`, `interface Y extends I`, `class Z extends Base`).
 */
function computeImplementations(sf: SourceFile, symbol: string): Set<string> {
  const decls = findDeclarations(sf, symbol);
  if (decls.length === 0) fail(`symbol "${symbol}" not found in ${sf.getFilePath()}`);

  const files = new Set<string>();

  for (const decl of decls) {
    const candidate = decl as Partial<ImplementationGetable>;
    if (typeof candidate.getImplementations !== "function") continue;
    for (const loc of (decl as ImplementationGetable).getImplementations()) {
      files.add(loc.getSourceFile().getFilePath());
    }
  }

  for (const ref of collectReferenceNodes(decls)) {
    const heritage = ref.getFirstAncestor(
      (a) => Node.isExpressionWithTypeArguments(a) || Node.isHeritageClause(a),
    );
    if (heritage) files.add(ref.getSourceFile().getFilePath());
  }

  return files;
}

/**
 * Files importing `target`. Walks import/export declarations and resolves each
 * module specifier through the compiler — so `@excalidraw/math` and a relative
 * `../math/src/index` both land on the same target — then unions in the language
 * service's own referencing-files view, which additionally covers dynamic
 * `import()` and `import type` node references.
 */
function computeImporters(
  project: Project,
  target: SourceFile,
  symbol: string | undefined,
): Set<string> {
  const targetPath = target.getFilePath();
  const files = new Set<string>();

  const matchesSymbol = (
    named: Array<{ getName(): string }>,
    hasNamespaceOrDefault: boolean,
  ): boolean => {
    if (!symbol) return true;
    if (hasNamespaceOrDefault) return true; // pulls in the whole module, symbol included
    return named.some((n) => n.getName() === symbol);
  };

  for (const sf of project.getSourceFiles()) {
    if (sf.getFilePath() === targetPath) continue;

    let hit = false;

    for (const imp of sf.getImportDeclarations()) {
      if (imp.getModuleSpecifierSourceFile()?.getFilePath() !== targetPath) continue;
      const hasNamespaceOrDefault =
        imp.getNamespaceImport() !== undefined || imp.getDefaultImport() !== undefined;
      if (matchesSymbol(imp.getNamedImports(), hasNamespaceOrDefault)) hit = true;
    }

    for (const exp of sf.getExportDeclarations()) {
      if (exp.getModuleSpecifierSourceFile()?.getFilePath() !== targetPath) continue;
      if (matchesSymbol(exp.getNamedExports(), exp.isNamespaceExport())) hit = true;
    }

    if (hit) files.add(sf.getFilePath());
  }

  // `--symbol` narrowing can't be applied to these (no named-binding info), so
  // only widen with them when the whole module is the question.
  if (!symbol) {
    for (const sf of target.getReferencingSourceFiles()) {
      files.add(sf.getFilePath());
    }
  }

  return files;
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const corpusRoot = await resolveCorpusRoot(opts.corpus);
  const absFile = path.resolve(corpusRoot, opts.file);

  const project = createProject(corpusRoot, opts.tsconfig);
  const sourceFile = getSourceFileOrFail(project, absFile);

  let absPaths: Set<string>;
  switch (opts.mode) {
    case "references":
      absPaths = computeReferences(sourceFile, opts.symbol!);
      break;
    case "implementations":
      absPaths = computeImplementations(sourceFile, opts.symbol!);
      break;
    case "importers":
      absPaths = computeImporters(project, sourceFile, opts.symbol);
      break;
  }

  if (!opts.includeSelf) absPaths.delete(sourceFile.getFilePath());

  const pool = [...absPaths]
    .map((p) => toRel(corpusRoot, p))
    .filter((rel) => opts.includeTests || !isTestPath(rel))
    .filter((rel) => !rel.startsWith("../") && !rel.includes("node_modules/"))
    .sort();

  console.error(
    `# mode=${opts.mode}${opts.symbol ? ` symbol=${opts.symbol}` : ""} ` +
      `file=${toRel(corpusRoot, absFile)} corpus=${corpusRoot} ` +
      `files=${pool.length}${opts.includeTests ? "" : " (tests excluded)"}` +
      `${opts.includeSelf ? "" : " (defining file excluded)"}`,
  );

  console.log(opts.json ? JSON.stringify(pool, null, 2) : pool.join("\n"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
