# Corpus-revision skew — every local-corpus result before 2026-08-17 is confounded

**Read this before re-reading any pre-2026-08-17 `results/token-economy/` or
`results/session-economy/` file as an arm-to-arm comparison on a
`kind: "local"` corpus.** Those runs did not point every arm at the same code.

## The mechanism

For a `kind: "local"` corpus, the arms resolved their checkouts two different
ways (`harness/lib/corpusResolver.ts`, before task #116):

- `baseline` (and every other arm running from the shared checkout) ran from
  `resolveWarm()`'s cache clone under `$TMPDIR/gmesh-bench-corpora/<corpus-id>`,
  which was cloned **once, the first time that path was ever used, and never
  refreshed** — the function only checked that the directory was a git repo.
- `gmesh-configured` / `serena-configured` / `kungfu-configured` / bare
  `serena` / `kungfu` ran from `resolveFresh()`/`resolveConfigured()` clones,
  which `mkdtemp` a new directory **per invocation** and therefore cloned the
  registry path's **current HEAD** every time.

So the two sides drifted apart the moment the operator committed anything to
the registered local checkout, silently, with nothing in the result JSON
recording which revision anything ran against.

## The evidence

On this machine the `task-tracker-mcp` cache clone sat at
`34b4fbe4` (merged 2026-07-29) while the live checkout moved to `35237c8b`
(merged **2026-08-14 00:49**), a merge that added `cancelRelease` to
`src/domain/lifecycle.ts` and pushed everything below it down 53 lines:

| revision | `cancelTask` in `src/domain/lifecycle.ts` |
| --- | --- |
| `34b4fbe4` (warm cache → `baseline`) | line 372 |
| `35237c8b` (source HEAD → configured arms) | line 425 |

Scanning `lifecycle.ts` line citations in the recorded answers shows exactly
that split opening up on the first sweep after the merge and never closing:

| sweep | `gmesh-configured` cites | `serena-configured` cites | `baseline` cites |
| --- | --- | --- | --- |
| 2026-08-11T21-40-37 | 372 | 371/382/389 | 372 |
| 2026-08-14T19-18-49 | **425** | **425** | **372** |
| 2026-08-16T00-35-12 | **425** | **424** | **372** |
| 2026-08-16T17-56-37 | **425** | **424** | **372** |

Both numbers are *correct*; the arms were reading different checkouts.

## Which results are affected

- **`task-tracker-mcp`, sweeps from `2026-08-14T19-18-49-088Z.json` onward**
  (including the full 387-record sweeps `2026-08-16T00-35-12-254Z.json` and
  `2026-08-16T17-56-37-519Z.json`): confounded. The `baseline` arm answered
  questions about a codebase 53 lines and one whole function different from
  the one the `gmesh-configured`/`serena-configured` arms saw. The size of the
  effect on token/turn/correctness numbers is **unknown and unquantifiable
  after the fact** — it is not a correction that can be applied, only a caveat.
- **`task-tracker-mcp`, sweeps before that date**: no divergence observed —
  every arm cited line 372, i.e. the cache and the live checkout happened to
  agree because nothing had been committed to that repo since the cache was
  made. Treat these as *probably* clean rather than *proven* clean: the only
  available evidence is line citations in answer text, which most tasks never
  produce.
- **`excalidraw`: not affected in practice.** It is `kind: "local"` too, so the
  same mechanism applied to it identically — it simply never fired, because
  that checkout has not moved since its cache clone was made (both the cache
  and the source sit at `1acf66ed`, a third-party repo nobody pulls on this
  machine). That was luck, not a property of the harness.
- **Not a `kind: "git"` problem.** Those entries cloned a pinned `ref` on every
  path, warm cache included, so their arms always agreed.

This is *not* the explanation for the apparent 2x `feature-request` gap
investigated in g-mesh #194 — that turned out to be sampling noise, and the
numbers there moved in a direction no single-cause corpus effect produces.
It is a separate, independent confound that happens to sit on the same data.

## What changed (task #116)

- `corpora/registry.json` entries take an explicit **`revision`** pin, and both
  shipped corpora are now pinned (`task-tracker-mcp` → `35237c8b`, the revision
  the configured arms had already been measuring; `excalidraw` → `1acf66ed`,
  which is what both sides were already on).
- `resolveCorpusRevision()` resolves that pin **once per process** and every
  clone path — warm cache, `resolveFresh()`, `resolveConfigured()` — checks the
  clone out onto it. The warm cache is **kept and refreshed**, not discarded: a
  stale cache directory is `git fetch`ed and hard-checked-out onto the resolved
  revision (which also discards anything a previous run left modified in it).
- Every run record now carries **`corpusRevision`**, alongside `serenaRevision`.
  A record without that field is, by definition, from before this fix — which
  makes "does this file state its corpus revision?" the test for whether a
  result predates the confound.

## Verification

`results/token-economy/2026-08-17T11-37-51-162Z.json` is a deliberately
minimal three-arm run (`tt-references-requiretask`, `G_MESH_BENCH_REPS=low`)
kept as the evidence that the arms now agree — a full sweep would have cost
~15.7h and ~$41 to prove the same one-line fact. All three records
(`gmesh-configured`, `serena-configured`, `baseline`) carry the identical
`"corpusRevision": "35237c8bab17c6b9bf1939d0a06e9e5d1c36bf4f"`, and the run log
shows the warm cache being brought forward on the way there:

```
[task-tracker-mcp] corpus revision 35237c8bab17c6b9bf1939d0a06e9e5d1c36bf4f (pinned in registry.json)
  warm task-tracker-mcp cache: 34b4fbe4 -> 35237c8b (refreshing)
```

After the run, `baseline`'s own checkout
(`$TMPDIR/gmesh-bench-corpora/task-tracker-mcp`) has `cancelTask` at line
**425** — the line the configured arms had been citing while baseline was
still reading 372.

**Refreshing to HEAD was considered and rejected as the primary answer.** It
would have made the arms agree within a run while making every *cross-run*
comparison drift instead — and this benchmark's ground truth is
content-anchored (`mode: "pool"` oracles are exact file lists,
`mode: "test"` tasks are premised on a bug that exists in a particular
revision, e.g. `tt-implement-release-cancelled-task-bug` against `releaseTask`),
so a corpus that tracks HEAD silently changes what "correct" means. Pinning
makes a corpus move only when someone edits `registry.json` — which is also
the moment `scripts/computeCandidatePool.ts` has to be re-run for that
corpus's `mode: "pool"` tasks (README, "Authoring `mode: "pool"` oracle
tasks").

**Sharing one checkout directory across all arms was also considered and
rejected.** The warm cache exists to avoid paying a cold g-mesh index (and a
`node_modules` install) every run, which is a benefit the `gmesh-configured`
arm would like too — but arms cannot share a *directory*, only a *revision*:
`gmesh-configured`/`kungfu-configured` write a `CLAUDE.md` into their cwd and
`serena-configured` writes `.claude/settings.json`, so one shared directory
would deliver one arm's configuration to every other arm (the exact failure
class that once had `baseline` answering in Russian off a leaked global
`CLAUDE.md`), and `kungfu`/`serena` write their indexes (`.kungfu/`,
`.serena/`) into the cwd where another arm's `Grep`/`Glob` would find them.
What the arms must share is the commit, which is what
`resolveCorpusRevision()` now guarantees. The performance half is still
available in a safe form — persistent per-`(corpus, arm, revision)` clones
instead of `mkdtemp` ones, so each arm keeps its own directory but stops
re-indexing it every run — and belongs to the separate "benchmark runs are too
slow to iterate on" task, not here.
