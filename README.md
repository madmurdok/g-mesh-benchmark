# g-mesh-bench

Benchmark suite measuring [g-mesh](../g-mesh)'s effectiveness as a coding-agent tool.
See `docs/architecture/g-mesh-bench-v1.md` for the full design.

Tracks three metrics, kept strictly separate — never merged into one report:

1. **Token economy** (primary) — how many tokens an agent burns completing the same
   code-navigation task with g-mesh available vs. grep/Read/Glob only. Measured two
   ways, reported separately: `token-economy` (one isolated process per task, the
   worst case for g-mesh's per-call tool-schema cost) and `session-economy` (a whole
   task list chained into one continuing session, closer to real Claude Code usage).
2. **Search latency** — raw wall-clock time per g-mesh tool call on a warm index,
   no LLM involved.
3. **Cold-start/indexing time** — an NFR metric: how long the first bulk-index walk
   takes, and how it scales with repo size.

## Getting started

Follow these in order the first time; after that, jumping straight to
[Running an experiment](#running-an-experiment) is enough.

1. **Prerequisites**
   - Node.js 20+ and `npm`.
   - The [`claude` CLI](https://claude.com/claude-code) installed and already
     authenticated (`claude` on `PATH`; try `claude --version` to confirm) —
     every experiment spawns real `claude -p` calls and pays for them the
     same way an interactive session would.
   - `git` (used to clone corpora into throwaway checkouts).
   - `kungfu` on `PATH` only if you plan to run the optional `kungfu`
     comparison arm (`G_MESH_BENCH_INCLUDE_KUNGFU=yes` — see below); skip it
     otherwise.

2. **Clone this repo as a sibling of `g-mesh`, not nested inside it.**
   `harness/lib/mcpConfig.ts`'s default binary path
   (`gmeshBinaryPath()`) resolves to `../../../g-mesh/core/target/release/g-mesh`
   relative to this file — i.e. it expects `g-mesh` and `g-mesh-bench` to sit
   side by side under the same parent directory:
   ```
   some-parent-dir/
     g-mesh/        <- github.com/<org>/g-mesh
     g-mesh-bench/  <- this repo
   ```
   A different layout works too, via `G_MESH_BENCH_BINARY=/path/to/g-mesh`
   (see `harness/lib/mcpConfig.ts`), but the sibling layout needs no
   configuration at all.

3. **Build the g-mesh binary** (only needed once, and again after pulling a
   newer `g-mesh`):
   ```bash
   cd ../g-mesh/core && cargo build --release
   cd ../g-mesh/plugins/js-ts && npm install && npm run build
   ```

4. **Install this repo's own dependencies:**
   ```bash
   npm install
   ```

5. **Point `corpora/registry.json` at real codebases.** Its two shipped
   entries (`task-tracker-mcp`, `excalidraw`) are `"kind": "local"` pointing
   at absolute paths on the machine this repo was developed on — they will
   not exist on a fresh clone, and every experiment reads this file to know
   what to benchmark against. Two ways to fix it, per entry:
   - **Point `path` at your own local checkout** — clone the corpus
     yourself, then set `path` to that checkout's absolute path. Fastest to
     iterate against (no clone-per-run cost for the shared/warm experiments),
     but the checkout is machine-specific, same as the shipped entries were.
   - **Switch to `"kind": "git"`** with a `repoUrl` and a pinned `ref`
     (commit SHA or tag) instead of `path` — portable, no local checkout
     needed; `corpusResolver.ts` clones it fresh into a throwaway directory
     as needed. This is the right choice for a corpus you don't already have
     checked out, or for a config you intend to share/commit.

   Either way, each corpus also needs its own `corpora/<corpus-id>/tasks.json`
   (already present for the two shipped corpora) — see
   [Authoring `mode: "pool"` oracle tasks](#authoring-mode-pool-oracle-tasks)
   below if you're adding a new corpus rather than reusing an existing one.

6. **Run one cheap experiment to confirm everything is wired up**, scoped to
   the smaller corpus and a single task so the first run costs pennies, not
   dollars:
   ```bash
   npm run token-economy -- tt-find-impl-completionverifier
   ```
   This builds the two default arms (`gmesh-configured`, `baseline`), runs
   that one task once against each, and prints a per-task markdown table plus
   an aggregate summary to the console.

7. **Read the results.** Every run writes:
   - A timestamped JSON file under `results/token-economy/` (or
     `results/session-economy/`, `results/search-latency/`,
     `results/cold-start/` for the other experiments) — the raw, permanent
     record.
   - A self-contained HTML report under `results/html/`, printed at the end
     of the run (`Wrote HTML report to results/html/<timestamp>.html`) — open
     it directly in a browser, no server needed.

   From here, [Running an experiment](#running-an-experiment) covers the
   other experiments and every `G_MESH_BENCH_*` knob, and
   [Configuration](#configuration) covers moving those same defaults into
   `g-mesh-bench.config.json` instead of passing them as env vars every time.

## Layout

- `corpora/` — test codebase registry (`registry.json`) and per-corpus task
  definitions (`<corpus-id>/tasks.json`). Adding a corpus or a task is a data-only
  change, never a harness code change.
- `harness/` — the three experiment runners plus shared `lib/` helpers.
- `results/<experiment>/` — one timestamped JSON file per run, kept forever for
  trend comparison.
- `results/html/` — one self-contained HTML report (charts + tables + written
  analysis) per `token-economy` run, timestamped the same way as its JSON
  sibling and kept forever alongside it; `session-economy` writes its own
  `session-<timestamp>.html` the same way. `npm run report` additionally writes
  `results/html/cumulative.html` (and `session-cumulative.html` for
  `npm run report -- session-economy`), overwritten every run (gitignored, not kept).
  Its per-task table reports each arm's mean turns split by what the turns were
  spent on — `8.0 (6.0 search, 2.0 edit)` — since on `implementation` tasks a raw
  turn count mixes navigation (the thing g-mesh is supposed to cut) with editing
  (the same job either way). Runs recorded before the harness parsed per-turn tool
  names show the bare turn count instead of a misleading 0.

## Configuration

Runtime defaults (default arms, repetition/scope presets, narrative/warm-cache/
transcript gates, search sample count) live in a checked-in
`g-mesh-bench.config.json` at the repo root instead of being hardcoded per
script. Precedence: **env var (if set) > config file value (if present) >
hardcoded default (if the file is absent or a field is omitted)**. A repo with
no config file at all behaves byte-identically to today — `loadBenchConfig()`
(see `harness/lib/benchConfig.ts`) falls back to its own `DEFAULT_CONFIG`
verbatim.

```json
{
  "tokenEconomy": {
    "arms": ["gmesh-configured", "baseline"],
    "repetitions": "normal",
    "excalidrawScope": "low",
    "htmlNarrative": true,
    "warmCache": "prompt"
  },
  "sessionEconomy": {
    "arms": ["gmesh", "baseline"],
    "repetitions": "normal"
  },
  "searchLatency": { "samples": 20 },
  "report": { "htmlNarrative": true },
  "runClaude": { "saveTranscripts": false }
}
```

`tokenEconomy.arms`/`sessionEconomy.arms` are each experiment's default arm
list; the `G_MESH_BENCH_INCLUDE_*` toggles below still work exactly as before,
additively appending an arm to whichever list the config resolves to rather
than replacing it. `G_MESH_BENCH_BINARY`/`G_MESH_BENCH_KUNGFU_BINARY` are
deliberately **not** part of this file — both are absolute, machine-local
filesystem paths, so they stay env-only (see `harness/lib/mcpConfig.ts`).

### Custom arms

Any other MCP-based code-search tool can be added as a comparison arm from this
file alone — no source change, same shape as the built-in `kungfu` arm (a real
MCP server plus a curated tool allowlist and a deny list):

```json
{
  "customArms": {
    "mytool": {
      "command": "mytool",
      "args": ["mcp"],
      "tools": ["mcp__mytool__find_symbol", "mcp__mytool__callers"],
      "deniedTools": ["mcp__mytool__semantic_search", "mcp__mytool__reindex"],
      "writesToProjectDir": true
    }
  },
  "tokenEconomy": { "arms": ["gmesh-configured", "mytool", "baseline"] }
}
```

- The key (`mytool`) is the arm's name everywhere: in `tokenEconomy.arms` /
  `sessionEconomy.arms`, in every result record and report table, and as the
  MCP server name its tools are namespaced under (`mcp__mytool__…`). It may not
  reuse a built-in arm name.
- `command`/`args` are spawned as a stdio MCP server, exactly like g-mesh's and
  kungfu's (`args` is required — write `[]` for a server that takes none).
- `tools` is the arm's `--tools` allowlist. `Read,Grep,Glob` are added
  automatically (every arm gets them), so list only `mcp__`-namespaced tools.
- `deniedTools` is usually **required in practice**, not optional: `--tools`
  restricts only the *built-in* tools and has no effect on `mcp__` ones, so a
  server exposing 40 tools still shows the model all 40 unless the ones outside
  your allowlist are denied explicitly. See `KUNGFU_DENIED_TOOLS` in
  `harness/lib/armConfig.ts` for the full explanation and how that list was
  produced (a live `tools/list` probe, diffed against the allowlist).
- `writesToProjectDir: true` (default `false`) declares that the tool writes
  state into whatever project directory it is pointed at — kungfu's `.kungfu/`
  index is the built-in example, as opposed to g-mesh, which indexes into
  `~/.g-mesh`. Such an arm gets its own throwaway clone per corpus instead of
  sharing the warm checkout, which must never be modified.
- Reporting needs nothing: `armsPresent()` renders any arm it finds in the run
  records, sorting names it doesn't rank in `ARM_ORDER` alphabetically last.

Known gaps, deliberately not covered in this pass:

- **No `-configured` variant.** Only `gmesh` and `kungfu` have a CLAUDE.md-loaded
  counterpart (`gmesh-configured`/`kungfu-configured`); those are wired to
  literal arm names in `harness/token-economy.ts`. A custom arm always runs
  bare, with no CLAUDE.md guidance written into its checkout.
- **Not part of the prompt-cache warm-up.** `warmCache()` warms the built-in
  arms' cache prefixes only, so a custom arm's first measured call pays its own
  tool-schema cost. Compare custom arms against each other with that in mind, or
  run with the warm-up off.

## Running an experiment

```bash
npm run token-economy   # experiment 1 (primary metric)
npm run search-latency  # experiment 2
npm run cold-start      # experiment 3
npm run session-economy # experiment 1b: experiment 1, measured inside one continuing session
npm run report          # aggregate whichever results/<experiment>/ you point it at
```

`token-economy` requires the g-mesh binary to be built (see
[Getting started](#getting-started) steps 2-3) and spends real API tokens per
run — see the design doc's failure-modes section for budget caps.

A default `token-economy` run compares two arms: **`gmesh-configured`** — g-mesh's
MCP tools plus the CLAUDE.md guidance an actual project would have, written into a
throwaway clone and auto-loaded by Claude Code — against **`baseline`**
(Read/Grep/Glob only). The configured arm is the default on purpose: the benchmark's
claim is about g-mesh as it is really used, and nobody ships it with no guidance at
all. Bare `gmesh` (the tools, no CLAUDE.md) is still available, now as an opt-in
extra — see `G_MESH_BENCH_INCLUDE_BARE_GMESH` below.

`token-economy` also supports:
- `G_MESH_BENCH_REPS=low|normal|max` — repetitions per (task, arm): 1/3/5 (default `normal`).
  Default now comes from `g-mesh-bench.config.json`'s `tokenEconomy.repetitions`; the env
  var still overrides it per-run.
- `npm run token-economy -- <taskId...>` — run only the named task(s) instead of the
  full registry, e.g. `npm run token-economy -- ex-find-impl-trail-crossfile`.
- `G_MESH_BENCH_WARM_CACHE=yes|no` — skip the interactive cache warm-up prompt
  for scripted/CI invocations. Default now comes from `g-mesh-bench.config.json`'s
  `tokenEconomy.warmCache` (`true`/`false` skip the prompt the same way the env var
  would; `"prompt"`, the default, keeps today's interactive behavior); the env var
  still overrides it per-run.
- `G_MESH_BENCH_EXCALIDRAW_SCOPE=low|normal|high` — how many of excalidraw's
  three `implementation` tasks a full registry run covers: 1/2/3, cheapest
  first (default `low`). Two separate costs motivate it. Every
  `implementation` task gets a throwaway clone per (task, arm, repetition) and
  installs the corpus's dependencies there before its test command can run;
  for excalidraw that is ~60-90s of `yarn install` every single time. And
  `ex-implement-library-dedup` — the one only `high` includes — routinely
  costs an arm call more than `MAX_BUDGET_USD`: both arms have been observed
  producing a correct fix and still being recorded `budget_exceeded` before
  grading, so including it can spend real money for no signal. Naming tasks
  explicitly (`npm run token-economy -- ex-implement-library-dedup`) bypasses
  this, as it bypasses every other default; task-tracker-mcp's own
  `implementation` task installs in ~11s and is never gated. Default preset now
  comes from `g-mesh-bench.config.json`'s `tokenEconomy.excalidrawScope`; the
  env var still overrides it per-run.
- `G_MESH_BENCH_HTML_NARRATIVE=yes|no` — whether to spend one extra cheap-model
  call generating a plain-English summary paragraph for the HTML report
  (default `yes`; `no` skips the call entirely, no spend). Applies to both
  `token-economy` (per-run report) and `report` (cumulative report). Default now
  comes from `g-mesh-bench.config.json`'s `tokenEconomy.htmlNarrative` (for
  `token-economy`) and `report.htmlNarrative` (for `report` — a separate field
  on purpose, see the Configuration section above); the env var still overrides
  either per-run.
- `G_MESH_BENCH_INCLUDE_BARE_GMESH=yes|no` — also run the bare `gmesh` arm
  (default `no`): g-mesh's tools with no CLAUDE.md guidance at all. It was the
  default primary arm until `gmesh-configured` took over, so turn it on to
  reproduce the old bare-vs-baseline comparison, or to measure what the
  CLAUDE.md guidance is itself worth by running bare and configured side by
  side. Adds a full extra run per (task, repetition). (Replaces the former
  `G_MESH_BENCH_INCLUDE_CONFIGURED`, which gated the arm that is now the
  default.) The gate itself is unchanged; it now appends onto whichever arm
  list `g-mesh-bench.config.json`'s `tokenEconomy.arms` resolves to, rather
  than onto a hardcoded literal.
- `G_MESH_BENCH_INCLUDE_TRUSTED=yes|no` — also run a third `gmesh-trusted` arm
  (default `no`): the same MCP config and tool list as `gmesh`, plus a
  harness-injected instruction not to re-verify g-mesh's results by hand. It
  measures what the gmesh arm's habitual self-verification actually costs and
  whether it buys any correctness — see
  `docs/results/v0.2.0-realistic-tasks-findings.md`'s "Turn-count evidence for
  the multi-hop self-verification pattern" for the investigation that motivated
  it. Adds a full third run per (task, repetition), so budget ~1.5x the usual
  API spend; with the flag off, nothing about the run or the report changes.
  Same "appends onto the config-driven arm list" note as
  `G_MESH_BENCH_INCLUDE_BARE_GMESH` above applies here too.
- `G_MESH_BENCH_INCLUDE_KUNGFU=yes|no` — also run a `kungfu` arm (default `no`):
  a third-party code-intelligence MCP server
  ([denyzhirkov/kungfu](https://github.com/denyzhirkov/kungfu)), restricted to
  a curated 6-tool subset chosen to match g-mesh's 7 capabilities as closely as
  it has analogs for (see `harness/lib/armConfig.ts`'s `KUNGFU_TOOLS` for the
  exact mapping and its two documented gaps: no reference-graph tool distinct
  from the call graph, and no interface-implementation tool at all). Requires
  `kungfu` on PATH (or `G_MESH_BENCH_KUNGFU_BINARY` pointed at it); adds a full
  extra run per (task, repetition). Same "appends onto the config-driven arm
  list" note applies here too.

### `session-economy` — the same comparison, amortized instead of isolated

`token-economy` runs every (task, arm, repetition) as a brand-new `claude -p`
process, so each one re-pays g-mesh's MCP tool-schema cost from cold (visible as
`cache_creation_input_tokens`). That is the worst case for g-mesh, and it is not
what real Claude Code usage looks like — a real session is one long conversation
asking many questions against the same registered tools.

`session-economy` chains one corpus's whole task list into a **single session per
arm** (`claude -p --resume <session_id>`) and records each task's own cost, so the
cold-start-then-amortize curve is directly observable: how much of the tool-schema
tax is a one-off first-call cost rather than a per-question one. Everything else —
arms, model, per-call budget cap, oracles — is identical to `token-economy`
(both import the same `harness/lib/armConfig.ts`), so the two experiments differ
only in isolated-vs-chained execution.

Its results live in `results/session-economy/` and get their own HTML report
(`results/html/session-<timestamp>.html` per run, `session-cumulative.html` from
`npm run report -- session-economy`). They are **never** blended into
`token-economy`'s headline aggregate — that math assumes each run is an isolated
measurement, and the same "never merge separate metrics" rule applies here as
between the three metrics above.

```bash
npm run session-economy                        # every corpus, both arms
npm run session-economy -- task-tracker-mcp    # one corpus only (the cheap smoke test)
npm run report -- session-economy              # cumulative report across past runs
```

- `G_MESH_BENCH_SESSION_REPS=low|normal|max` — independent chains per (corpus,
  arm): 1/2/3 (default `normal`). Deliberately a *separate* variable from
  `G_MESH_BENCH_REPS`, with smaller presets: one repetition here costs a whole
  chain (5 or 15 calls per arm), not a single call. Default now comes from
  `g-mesh-bench.config.json`'s `sessionEconomy.repetitions`; the env var still
  overrides it per-run.
- `npm run session-economy -- <corpusId...>` — run only the named corpus/corpora.
  Corpus-level only, never a task subset: a chain's premise is one realistic
  session over that codebase's whole question list, so an arbitrary subset would
  change what a sequence position means.
- `G_MESH_BENCH_INCLUDE_TRUSTED=yes|no` — same third `gmesh-trusted` arm as above
  (default `no`); here it adds a whole extra chain per (corpus, repetition).
  Appends onto whichever arm list `g-mesh-bench.config.json`'s
  `sessionEconomy.arms` resolves to, same as `token-economy`'s toggles above.
- `G_MESH_BENCH_BINARY` — path to the g-mesh binary, same as `token-economy`.
- No cache warm-up knob (unlike `token-economy`'s `G_MESH_BENCH_WARM_CACHE`) and
  no narrative call: pre-warming would hide exactly the curve this experiment
  exists to measure, and the narrative prompt is written against
  `token-economy`'s isolated-run aggregate.

A chain aborts as soon as one of its calls fails, blows the budget, or comes back
without a resumable `session_id` — every remaining task in that chain is recorded
with `status: "skipped"` rather than dropped, so a short chain says why it is short.

By default, `npm run report` only compares runs graded against each task's
*current* prompt/oracle definition — a run recorded before a task was edited
is excluded and listed in an "Excluded as stale" section instead of silently
blended into the aggregate (see `docs/results/v0.2.0-realistic-tasks-findings.md`'s
"Stale run-record contamination" section for the bug this fixes). Pass
`npm run report -- --all` to include every run regardless of staleness,
reproducing the old unscoped behavior.

## Authoring `mode: "pool"` oracle tasks

Tasks whose answer is an enumerable set of files ("list at least N callers/
importers/implementers") use `oracle.mode: "pool"` — a `candidatePool` of every
valid file, computed independently of g-mesh, graded by counting how many
pool members the agent's answer mentions (`>= minMatches` passes). See
`docs/architecture/g-mesh-bench-v2-realistic-tasks.md` for why (a hand-picked
`mustMentionFiles` subset produces false negatives whenever the agent
correctly names a different valid subset than the task author guessed).

Compute the pool with `scripts/computeCandidatePool.ts`, e.g.:

```bash
npx tsx scripts/computeCandidatePool.ts --corpus excalidraw \
  --symbol pointFrom --file packages/math/src/point.ts --mode references --json
```

then paste the printed file list into the task's `oracle.candidatePool`.

**Re-run it whenever a corpus's pinned `ref` in `corpora/registry.json` is
bumped.** Pools are computed once, at authoring time, against that specific
ref — they are not automatically refreshed. Moving the ref without
re-running `computeCandidatePool.ts` for every `mode: "pool"` task in that
corpus silently grades against a stale ground truth (a real, if less severe,
version of the same bug the pool mode itself exists to fix). This is a
deliberate manual step, not automated — see the architecture doc's Failure
Modes section.
