# g-mesh-bench

Benchmark suite measuring [g-mesh](../g-mesh)'s effectiveness as a coding-agent tool.
See `docs/architecture/g-mesh-bench-v1.md` for the full design.

Tracks three metrics, kept strictly separate — never merged into one report:

1. **Token economy** (primary) — how many tokens an agent burns completing the same
   code-navigation task with g-mesh available vs. grep/Read/Glob only.
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
  sibling and kept forever alongside it. `npm run report` additionally writes
  `results/html/cumulative.html`, overwritten every run (gitignored, not kept).

## Running an experiment

```bash
npm run token-economy   # experiment 1 (primary metric)
npm run search-latency  # experiment 2
npm run cold-start      # experiment 3
npm run report          # aggregate whichever results/<experiment>/ you point it at
```

`token-economy` requires the g-mesh binary to be built
(`cd ../g-mesh/core && cargo build --release`,
`cd ../g-mesh/plugins/js-ts && npm install && npm run build`) and spends real API
tokens per run — see the design doc's failure-modes section for budget caps.

`token-economy` also supports:
- `G_MESH_BENCH_REPS=low|normal|max` — repetitions per (task, arm): 1/3/5 (default `normal`).
- `npm run token-economy -- <taskId...>` — run only the named task(s) instead of the
  full registry, e.g. `npm run token-economy -- ex-find-impl-trail-crossfile`.
- `G_MESH_BENCH_WARM_CACHE=yes|no` — skip the interactive cache warm-up prompt
  for scripted/CI invocations.
- `G_MESH_BENCH_HTML_NARRATIVE=yes|no` — whether to spend one extra cheap-model
  call generating a plain-English summary paragraph for the HTML report
  (default `yes`; `no` skips the call entirely, no spend). Applies to both
  `token-economy` (per-run report) and `report` (cumulative report).

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
