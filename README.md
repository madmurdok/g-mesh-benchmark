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
