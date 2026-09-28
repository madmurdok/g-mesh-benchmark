/**
 * The expected answers for GMB-180's semantic-tier tasks, derived from each
 * corpus's own source text at its pinned revision - and from nothing else.
 *
 * GMB-160's rule is why this file exists rather than a paragraph in a commit
 * message: an oracle produced by the tool under test measures nothing, so no
 * expected answer in `corpora/{gin,ripgrep,py-requests}/tasks.json` may come
 * from a g-mesh response. `scripts/probeLanguageTiers.ts` is still what shows
 * a task *needs* the semantic tier; this script is what says what the right
 * answer is. The two are deliberately independent: if they disagree, that is a
 * finding about g-mesh, which is the whole point of a benchmark.
 *
 * Why regexes over source text rather than each language's own toolchain: the
 * semantic facts these tasks turn on (Go's implicit interface satisfaction,
 * Python's receiver types, Rust's `dyn` dispatch) are exactly what `go/types`,
 * pyright and rust-analyzer compute - the same engines g-mesh's semantic tier
 * drives. Re-deriving an oracle from the same engine that produced the answer
 * under test would be circular a second way. Each derivation below therefore
 * states the narrow syntactic rule it applies, and prints the source line that
 * makes each classification checkable by eye. Where a rule cannot decide a
 * case, it says so rather than guessing.
 *
 * Run (no arguments):
 *   npx tsx scripts/deriveSemanticOracles.ts
 */

import fs from "node:fs";
import path from "node:path";

import { resolveWarm } from "../harness/lib/corpusResolver.js";
import { loadRegistry } from "../harness/lib/taskLoader.js";

function walk(root: string, ext: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "target") continue;
        stack.push(full);
      } else if (entry.name.endsWith(ext) && !skip(rel)) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

function readLines(root: string, rel: string): string[] {
  return fs.readFileSync(path.join(root, rel), "utf8").split("\n");
}

function heading(title: string): void {
  console.log(`\n${"=".repeat(78)}\n${title}\n${"=".repeat(78)}`);
}

// ---------------------------------------------------------------------------
// gin-find-impl-render
//
// Rule: a Go type satisfies `render.Render` iff its method set contains BOTH
// `Render(http.ResponseWriter) error` and `WriteContentType(http.ResponseWriter)`.
// That is the interface's own declaration (render/render.go), and Go's
// satisfaction is by method set alone - no `implements` clause exists to match
// on. So: collect every method declaration in the repository, group by receiver
// type name, and intersect. A type carrying only one of the two is reported
// separately, because those are precisely the rows a name-keyed lookup returns
// and an implementations answer must not.
// ---------------------------------------------------------------------------

const GO_METHOD = /^func \(\s*(?:[A-Za-z_][A-Za-z0-9_]*\s+)?\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

function goMethodsByReceiver(root: string): Map<string, { method: string; file: string; line: number }[]> {
  const byReceiver = new Map<string, { method: string; file: string; line: number }[]>();
  for (const rel of walk(root, ".go")) {
    readLines(root, rel).forEach((text, i) => {
      const m = GO_METHOD.exec(text);
      if (m === null) return;
      const receiver = m[1] ?? "";
      const method = m[2] ?? "";
      const list = byReceiver.get(receiver) ?? [];
      list.push({ method, file: rel, line: i + 1 });
      byReceiver.set(receiver, list);
    });
  }
  return byReceiver;
}

function deriveGinRenderImplementors(root: string): void {
  heading("gin-find-impl-render — types whose method set satisfies render.Render");
  console.log("rule: has BOTH Render(http.ResponseWriter) error AND WriteContentType(http.ResponseWriter)");
  const byReceiver = goMethodsByReceiver(root);
  const both: string[] = [];
  const renderOnly: string[] = [];
  for (const [receiver, methods] of [...byReceiver].sort()) {
    const render = methods.find((m) => m.method === "Render");
    const writeContentType = methods.find((m) => m.method === "WriteContentType");
    if (render === undefined) continue;
    if (writeContentType !== undefined) {
      both.push(`${receiver}  (${render.file}:${render.line}, ${writeContentType.file}:${writeContentType.line})`);
    } else {
      renderOnly.push(`${receiver}  (${render.file}:${render.line}) — Render only, NO WriteContentType`);
    }
  }
  console.log(`\nimplementors (${both.length}):`);
  for (const line of both) console.log(`  ${line}`);
  console.log(`\nsame-named methods that are NOT implementors (${renderOnly.length}):`);
  for (const line of renderOnly) console.log(`  ${line}`);

  // The interface's own `var _ Render = (*T)(nil)` assertion block is the
  // obvious shortcut a reader reaches for, and it is not the answer: it is
  // hand-maintained, so it both omits implementors and lists types that
  // implement a *different* interface (HTMLRender). Printed so the task's
  // rubric can say which types it gets wrong rather than merely that it does.
  const asserted = readLines(root, "render/render.go")
    .map((l) => /^\s*_\s+(Render|HTMLRender)\s*=\s*\(\*([A-Za-z_][A-Za-z0-9_]*)\)/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null);
  const assertedRender = asserted.filter((m) => m[1] === "Render").map((m) => m[2]);
  const assertedHtml = asserted.filter((m) => m[1] === "HTMLRender").map((m) => m[2]);
  const implementorNames = both.map((b) => b.split("  ")[0]);
  console.log(`\nrender/render.go's own "var _ Render" block lists ${assertedRender.length}:`);
  console.log(`  missing from it: ${implementorNames.filter((n) => !assertedRender.includes(n)).join(", ")}`);
  console.log(`  it also lists, as HTMLRender (a different interface): ${assertedHtml.join(", ")}`);
}

// ---------------------------------------------------------------------------
// gin-callers-writeheadernow-dispatch
//
// Rule: every `<expr>.WriteHeaderNow()` call site is classified by the DECLARED
// type of the receiver expression, which in this corpus takes exactly three
// forms and no others (the script asserts that, rather than assuming it):
//
//   1. `<recv>.WriteHeaderNow()` where `<recv>` is the enclosing method's own
//      receiver     -> that method's receiver type.
//   2. `<recv>.<field>.WriteHeaderNow()` / `<param>.<field>.WriteHeaderNow()`
//      -> the declared type of `<field>` on the owning struct.
//   3. `<local>.WriteHeaderNow()` where `<local>` was bound in the same
//      function by `var x T = ...`, `x := T(...)` or `x := &T{...}`
//      -> `T`.
//
// Forms 2 and 3 are why this is a semantic question: `c.Writer` and
// `c.writermem` are the same syntax and different types, `w := ResponseWriter(writer)`
// and `w := &responseWriter{...}` are the same syntax and different types, and
// only the declaration each one refers back to says which. The script prints
// `UNRESOLVED(...)` for any site none of the three forms covers, so a gap
// shows up as a gap rather than being silently attributed.
// ---------------------------------------------------------------------------

function goStructFieldTypes(root: string, rel: string): Map<string, Map<string, string>> {
  const byStruct = new Map<string, Map<string, string>>();
  const lines = readLines(root, rel);
  let current: string | null = null;
  for (const text of lines) {
    const open = /^type ([A-Za-z_][A-Za-z0-9_]*) struct \{/.exec(text);
    if (open !== null) {
      current = open[1] ?? "";
      byStruct.set(current, new Map());
      continue;
    }
    if (current !== null && /^\}/.test(text)) {
      current = null;
      continue;
    }
    if (current === null) continue;
    const field = /^\t([A-Za-z_][A-Za-z0-9_]*)\s+\*?([A-Za-z_][A-Za-z0-9_.]*)/.exec(text);
    if (field !== null) byStruct.get(current)!.set(field[1] ?? "", field[2] ?? "");
  }
  return byStruct;
}

function deriveGinWriteHeaderNowCallSites(root: string): void {
  heading("gin-callers-writeheadernow-dispatch — call sites split by the receiver's declared type");
  const fields = goStructFieldTypes(root, "context.go");
  const contextFields = fields.get("Context") ?? new Map<string, string>();
  console.log(
    `Context's own field declarations (context.go): Writer=${contextFields.get("Writer")}, writermem=${contextFields.get("writermem")}`,
  );
  const perType = new Map<string, { site: string; enclosing: string }[]>();
  for (const rel of walk(root, ".go")) {
    const lines = readLines(root, rel);
    let enclosing = "";
    let receiverVar = "";
    let receiverType = "";
    let locals = new Map<string, string>();
    lines.forEach((text, i) => {
      const fn =
        /^func (?:\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
          text,
        );
      if (fn !== null) {
        receiverVar = fn[1] ?? "";
        receiverType = fn[2] ?? "";
        enclosing = receiverType === "" ? (fn[3] ?? "") : `${receiverType}.${fn[3] ?? ""}`;
        locals = new Map();
      }
      const bind =
        /^\s*(?:var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?::=|=)\s*&?([A-Za-z_][A-Za-z0-9_]*)\s*[({]/.exec(text) ??
        /^\s*var\s+([A-Za-z_][A-Za-z0-9_]*)\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text) ??
        // A function literal's own parameter, e.g. `action: func(w ResponseWriter) error {` —
        // the same binding a `:=` makes, written in the one other place Go
        // lets a name acquire a declared type inside a function body.
        /\bfunc\(\s*([A-Za-z_][A-Za-z0-9_]*)\s+\*?([A-Za-z_][A-Za-z0-9_]*)\s*\)/.exec(text);
      if (bind !== null && bind[1] !== undefined && bind[2] !== undefined) locals.set(bind[1], bind[2]);
      const call = /(?:^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\.WriteHeaderNow\(\)/.exec(text);
      if (call === null) return;
      const base = call[1] ?? "";
      const field = call[2];
      let declared: string;
      if (field === undefined) {
        declared = base === receiverVar ? receiverType : (locals.get(base) ?? `UNRESOLVED(${base})`);
      } else {
        // The base is the enclosing method's receiver or a local/parameter;
        // either way it is the struct whose field list decides the type.
        const struct = base === receiverVar ? receiverType : (locals.get(base) ?? "Context");
        declared = fields.get(struct)?.get(field) ?? `UNRESOLVED(${base}.${field})`;
      }
      const list = perType.get(declared) ?? [];
      list.push({ site: `${rel}:${i + 1}  in ${enclosing}  —  ${text.trim()}`, enclosing: `${rel}:${enclosing}` });
      perType.set(declared, list);
    });
  }
  for (const [declared, sites] of [...perType].sort()) {
    const callers = [...new Set(sites.map((s) => s.enclosing))];
    console.log(
      `\nreceiver's declared type = ${declared}  (${sites.length} call sites in ${callers.length} distinct functions):`,
    );
    for (const site of sites) console.log(`  ${site.site}`);
  }
}

// ---------------------------------------------------------------------------
// py-callers-prepare-two-classes
//
// Rule: `requests` declares `prepare` twice — `Request.prepare` and
// `PreparedRequest.prepare`. A `<name>.prepare(` call site is attributed to
// whichever class most recently bound `<name>` in the same file, via either
// `<name> = PreparedRequest()` or `<name> = Request(...)` / `requests.Request(...)`,
// and to `UNRESOLVED` otherwise. Docstring lines (`>>> ...`) are excluded:
// they are documentation, not code, and no caller edge exists for them.
// ---------------------------------------------------------------------------

function derivePyPrepareCallSites(root: string): void {
  heading("py-callers-prepare-two-classes — .prepare( call sites, attributed by the receiver's binding");
  const perClass = new Map<string, string[]>();
  for (const rel of walk(root, ".py")) {
    const bindings = new Map<string, string>();
    let enclosing = "";
    readLines(root, rel).forEach((text, i) => {
      const def = /^\s*def ([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(text);
      if (def !== null) enclosing = def[1] ?? "";
      const bind = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:requests\.)?(PreparedRequest|Request)\s*\(/.exec(text);
      if (bind !== null) bindings.set(bind[1] ?? "", bind[2] ?? "");
      if (/^\s*(>>>|\.\.\.)/.test(text)) return; // docstring example, not code
      const call = /(?:^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)\.prepare\(/.exec(text);
      if (call === null) return;
      const cls = bindings.get(call[1] ?? "") ?? "UNRESOLVED";
      const list = perClass.get(cls) ?? [];
      list.push(`${rel}:${i + 1}  in ${enclosing}()  —  ${text.trim()}`);
      perClass.set(cls, list);
    });
  }
  for (const [cls, sites] of [...perClass].sort()) {
    const src = sites.filter((s) => s.startsWith("src/"));
    console.log(`\nreceiver bound as ${cls}: ${sites.length} call sites, ${src.length} of them under src/`);
    for (const site of src) console.log(`  ${site}`);
    if (sites.length > src.length) console.log(`  (+${sites.length - src.length} under tests/, not listed)`);
  }
}

// ---------------------------------------------------------------------------
// py-callers-register-hook-mixin
//
// Rule: `register_hook` is declared exactly once, on `RequestHooksMixin`
// (src/requests/models.py). Every `<recv>.register_hook(` site is classified
// by how `<recv>` reaches that declaration:
//
//   - `<recv>` is `self` -> the enclosing `class` statement, printed with its
//     base list, so a reader can see for themselves whether the mixin is on
//     it;
//   - otherwise -> the enclosing `def`'s parameter annotation for that name
//     (`def __call__(self, r: PreparedRequest)`), printed verbatim.
//
// Neither form names the mixin at the call site, which is the whole point:
// two callers reach it by inheritance from a class that is not the one
// declaring the method, and the third does not inherit it at all.
// ---------------------------------------------------------------------------

function derivePyRegisterHookCallSites(root: string): void {
  heading("py-callers-register-hook-mixin — .register_hook( call sites and how each receiver reaches the mixin");
  for (const rel of walk(root, ".py")) {
    if (!rel.startsWith("src/")) continue;
    const lines = readLines(root, rel);
    let cls = "";
    let def = "";
    lines.forEach((text, i) => {
      const c = /^class ([A-Za-z_][A-Za-z0-9_]*)\s*(\(([^)]*)\))?:/.exec(text);
      if (c !== null) cls = `${c[1]}(${c[3] ?? ""})`;
      const d = /^\s*def ([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)$/.exec(text);
      if (d !== null) def = `${d[1]}(${d[2] ?? ""}`;
      const call = /(?:^|[^.\w])([A-Za-z_][A-Za-z0-9_]*)\.register_hook\(/.exec(text);
      if (call === null) return;
      const recv = call[1] ?? "";
      const annotation = new RegExp(`\\b${recv}\\s*:\\s*([A-Za-z_][A-Za-z0-9_]*)`).exec(def);
      const how =
        recv === "self"
          ? `self -> enclosing class ${cls}`
          : `parameter \`${recv}\` -> annotated ${annotation?.[1] ?? "UNRESOLVED"} (from \`${def.trim()}\`), NOT inherited by ${cls}`;
      console.log(`  ${rel}:${i + 1}  in ${def.split("(")[0]}()  —  ${text.trim()}\n      ${how}`);
    });
  }
  const decls: string[] = [];
  for (const rel of walk(root, ".py")) {
    readLines(root, rel).forEach((text, i) => {
      if (/^\s*def (register_hook|deregister_hook)\s*\(/.test(text)) decls.push(`${rel}:${i + 1}  ${text.trim()}`);
    });
  }
  console.log(`\ndeclarations of register_hook/deregister_hook (${decls.length}):`);
  for (const d of decls) console.log(`  ${d}`);
}

// ---------------------------------------------------------------------------
// rs-callers-flag-name-long-dyn
//
// Rule: `Flag::name_long` is declared once, on the trait (crates/core/flags/mod.rs),
// and implemented once per flag struct in crates/core/flags/defs.rs. EVERY
// `.name_long()` call site in the workspace is reported with the enclosing
// function's signature, which is what says whether the receiver is a trait
// object (`&dyn Flag` / an element of `FLAGS: &[&dyn Flag]`) or a concrete
// type. A call whose receiver is a concrete flag struct would be attributable
// to that struct's own impl; the signature is printed for every site so that
// claim is checkable rather than asserted.
//
// defs.rs is NOT excluded, even though its 104 `impl Flag for ...` blocks
// declare the method: the impls' bodies are string literals and call nothing,
// so every `.name_long()` in that file is in its `mod tests`. An earlier
// version of this rule skipped the file wholesale and so under-counted the
// call sites by seven test functions - which is the sort of quiet omission
// this script exists to make visible, so each site is instead tagged with
// whether it sits under a `mod tests`.
// ---------------------------------------------------------------------------

function deriveRsNameLongCallSites(root: string): void {
  heading("rs-callers-flag-name-long-dyn — every .name_long() call site, with its receiver's origin");
  const declarations: string[] = [];
  const sites: { rel: string; line: number; enclosing: string; text: string; isTest: boolean }[] = [];
  for (const rel of walk(root, ".rs")) {
    const lines = readLines(root, rel);
    let enclosing = "";
    let testModLine = -1;
    lines.forEach((text, i) => {
      if (/^\s*mod tests\b/.test(text)) testModLine = i;
      const fn = /^\s*(?:pub(?:\([a-z]+\))?\s+)?fn ([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(text);
      if (fn !== null) enclosing = `${fn[1] ?? ""}  ::  ${text.trim()}`;
      if (/fn name_long\(&self\)/.test(text)) declarations.push(`${rel}:${i + 1}  ${text.trim()}`);
      if (!/\.name_long\(\)/.test(text)) return;
      sites.push({ rel, line: i + 1, enclosing, text: text.trim(), isTest: testModLine >= 0 && i > testModLine });
    });
  }
  const trait = declarations.filter((d) => d.includes("flags/mod.rs"));
  console.log(`\ndeclarations of name_long: ${declarations.length} total, ${trait.length} on the trait itself`);
  for (const d of trait) console.log(`  trait: ${d}`);
  console.log(`  impls: ${declarations.length - trait.length} (all in crates/core/flags/defs.rs)`);

  for (const bucket of [false, true]) {
    const chosen = sites.filter((s) => s.isTest === bucket);
    const files = [...new Set(chosen.map((s) => s.rel))].sort();
    const fns = [...new Set(chosen.map((s) => `${s.rel}:${s.enclosing.split("  ::  ")[0]}`))];
    console.log(
      `\n${bucket ? "TEST" : "NON-TEST"} call sites: ${chosen.length} in ${fns.length} functions across ${files.length} files`,
    );
    console.log(`  files: ${files.join(", ")}`);
    for (const s of chosen) console.log(`  ${s.rel}:${s.line}  in ${s.enclosing}\n        ${s.text}`);
  }
}

async function main(): Promise<void> {
  const registry = await loadRegistry();
  const roots = new Map<string, string>();
  for (const id of ["gin", "py-requests", "ripgrep"]) {
    const entry = registry.find((e) => e.id === id);
    if (entry === undefined) throw new Error(`corpus ${id} is not in corpora/registry.json`);
    roots.set(id, await resolveWarm(entry));
  }
  deriveGinRenderImplementors(roots.get("gin")!);
  deriveGinWriteHeaderNowCallSites(roots.get("gin")!);
  derivePyPrepareCallSites(roots.get("py-requests")!);
  derivePyRegisterHookCallSites(roots.get("py-requests")!);
  deriveRsNameLongCallSites(roots.get("ripgrep")!);
}

void main();
