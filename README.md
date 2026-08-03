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

## Running an experiment

```bash
npm run token-economy   # experiment 1 (primary metric)
npm run search-latency  # experiment 2
npm run cold-start      # experiment 3
npm run session-economy # experiment 1b: experiment 1, measured inside one continuing session
npm run report          # aggregate whichever results/<experiment>/ you point it at
```

`token-economy` requires the g-mesh binary to be built
(`cd ../g-mesh/core && cargo build --release`,
`cd ../g-mesh/plugins/js-ts && npm install && npm run build`) and spends real API
tokens per run — see the design doc's failure-modes section for budget caps.

A default `token-economy` run compares two arms: **`gmesh-configured`** — g-mesh's
MCP tools plus the CLAUDE.md guidance an actual project would have, written into a
throwaway clone and auto-loaded by Claude Code — against **`baseline`**
(Read/Grep/Glob only). The configured arm is the default on purpose: the benchmark's
claim is about g-mesh as it is really used, and nobody ships it with no guidance at
all. Bare `gmesh` (the tools, no CLAUDE.md) is still available, now as an opt-in
extra — see `G_MESH_BENCH_INCLUDE_BARE_GMESH` below.

`token-economy` also supports:
- `G_MESH_BENCH_REPS=low|normal|max` — repetitions per (task, arm): 1/3/5 (default `normal`).
- `npm run token-economy -- <taskId...>` — run only the named task(s) instead of the
  full registry, e.g. `npm run token-economy -- ex-find-impl-trail-crossfile`.
- `G_MESH_BENCH_WARM_CACHE=yes|no` — skip the interactive cache warm-up prompt
  for scripted/CI invocations.
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
  `implementation` task installs in ~11s and is never gated.
- `G_MESH_BENCH_HTML_NARRATIVE=yes|no` — whether to spend one extra cheap-model
  call generating a plain-English summary paragraph for the HTML report
  (default `yes`; `no` skips the call entirely, no spend). Applies to both
  `token-economy` (per-run report) and `report` (cumulative report).
- `G_MESH_BENCH_INCLUDE_BARE_GMESH=yes|no` — also run the bare `gmesh` arm
  (default `no`): g-mesh's tools with no CLAUDE.md guidance at all. It was the
  default primary arm until `gmesh-configured` took over, so turn it on to
  reproduce the old bare-vs-baseline comparison, or to measure what the
  CLAUDE.md guidance is itself worth by running bare and configured side by
  side. Adds a full extra run per (task, repetition). (Replaces the former
  `G_MESH_BENCH_INCLUDE_CONFIGURED`, which gated the arm that is now the
  default.)
- `G_MESH_BENCH_INCLUDE_TRUSTED=yes|no` — also run a third `gmesh-trusted` arm
  (default `no`): the same MCP config and tool list as `gmesh`, plus a
  harness-injected instruction not to re-verify g-mesh's results by hand. It
  measures what the gmesh arm's habitual self-verification actually costs and
  whether it buys any correctness — see
  `docs/results/v0.2.0-realistic-tasks-findings.md`'s "Turn-count evidence for
  the multi-hop self-verification pattern" for the investigation that motivated
  it. Adds a full third run per (task, repetition), so budget ~1.5x the usual
  API spend; with the flag off, nothing about the run or the report changes.
- `G_MESH_BENCH_INCLUDE_KUNGFU=yes|no` — also run a `kungfu` arm (default `no`):
  a third-party code-intelligence MCP server
  ([denyzhirkov/kungfu](https://github.com/denyzhirkov/kungfu)), restricted to
  a curated 6-tool subset chosen to match g-mesh's 7 capabilities as closely as
  it has analogs for (see `harness/lib/armConfig.ts`'s `KUNGFU_TOOLS` for the
  exact mapping and its two documented gaps: no reference-graph tool distinct
  from the call graph, and no interface-implementation tool at all). Requires
  `kungfu` on PATH (or `G_MESH_BENCH_KUNGFU_BINARY` pointed at it); adds a full
  extra run per (task, repetition).

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
  chain (5 or 15 calls per arm), not a single call.
- `npm run session-economy -- <corpusId...>` — run only the named corpus/corpora.
  Corpus-level only, never a task subset: a chain's premise is one realistic
  session over that codebase's whole question list, so an arbitrary subset would
  change what a sequence position means.
- `G_MESH_BENCH_INCLUDE_TRUSTED=yes|no` — same third `gmesh-trusted` arm as above
  (default `no`); here it adds a whole extra chain per (corpus, repetition).
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
