# find_implementations token-increase investigation

Task: task-tracker `g-mesh` project, task #77
(`90a2165d-1fd1-4847-a6bb-027698ae8e00`). Follow-up to
`v0.1.1-postfix-rerun.md`'s anomaly #2: both `find_implementations` tasks
dropped from 5→3 turns after the 0.1.1 bugfix batch, but total
`cacheCreationTokens` rose ~28-37% anyway. No stream-json trace existed for
the post-fix runs, so this captures one.

Date: 2026-07-29. g-mesh binary built from `fix/import-resolution` branch,
commit `dc479eb` (`fix: find_references misses usages filed as
CALLS/SUPERTYPE_OF`) on top of `01d37c8` (`fix: exclude .claude/ from bulk
index and file watcher`) — the same two fixes the postfix-rerun doc
describes. The branch also has an unrelated, uncommitted import-resolution
WIP (`core/src/graph/imports.rs`, `daemon/bulk_index.rs`, etc.) that does not
touch `find_definition.rs`/`find_file_outline.rs`/`find_implementations.rs`,
so it shouldn't affect this trace.

Repro: `claude -p --output-format stream-json --verbose` against the
`task-tracker-mcp` corpus (same prompts as `corpora/task-tracker-mcp/tasks.json`),
same tool string (`Read,Grep,Glob,mcp__g-mesh__*`) and same mcp-config shape
the harness (`harness/token-economy.ts` / `lib/runClaude.ts`) uses, just with
`stream-json` instead of `json` to see per-turn payloads.

## What actually happened, both tasks

Both traces show the **same clean 3-turn shape**, and it does not match either
of the task's two suspicions:

**`tt-find-impl-completionverifier`**
1. `find_definition({symbol_name: "CompletionVerifier"})` → **one** match (not
   two — no `.claude/worktrees` duplicate), and it now includes an `"id"`
   field:
   ```json
   {"id":"8c4ce627174905491e36e903d5842f09","kind":"Type","name":"CompletionVerifier","qualifiedName":"CompletionVerifier","filePath":"src/domain/verification.ts","startLine":13,"startCol":7,"endLine":15,"endCol":1,"signature":null,"docComment":null}
   ```
   (309 bytes)
2. `find_implementations({symbol_id: "8c4ce627174905491e36e903d5842f09"})` —
   the `id` from step 1 used directly, **no guessing, no error** — succeeds
   immediately:
   ```json
   {"results":[{"implementingSymbolId":"64a6136a579ef239b0384b6d8df84451","name":"GitDiffCompletionVerifier","qualifiedName":"GitDiffCompletionVerifier","kind":"Type","filePath":"src/domain/verification.ts","startLine":25,"startCol":7,"resolved":false}],"hasMore":false,"nextCursor":null}
   ```
   (347 bytes)
3. Final answer.

**`tt-find-impl-budgetestimator`** — identical shape: `find_definition`
returns one match + `id` (233 bytes) → `find_implementations` with that `id`
succeeds directly (277 bytes) → answer.

This directly contradicts the task's suspicion #1 (that `find_definition`
still omits `symbolId`, forcing a `get_file_outline` detour per
`turn-count-investigation.md`). It doesn't — at least not when there's a
single unambiguous match. The pre-fix trace's "no symbolId field" behavior
was captured when `find_definition` had **two** candidates (the real file +
a stale `.claude/worktrees` duplicate); post-fix, with duplicates excluded,
there's one candidate and it carries a usable `id`. Whether `find_definition`
suppresses `id` specifically when results are ambiguous, or the pre-fix doc's
observation was incidental to some other pre-0.1.1 behavior, wasn't chased
further — either way, current behavior is strictly better than described:
2 clean tool calls, 0 fallbacks to `Read`/`Grep`, 0 failed guesses.

Suspicion #2 (get_file_outline/find_implementations themselves grew
heavier) also doesn't hold up: both tool-result payloads here are small
(233-347 bytes) and the per-turn incremental `cache_creation_input_tokens`
they cause is modest and consistent across both tasks:

| Task | find_definition result | Δcache_creation | find_implementations result | Δcache_creation |
|---|---|---|---|---|
| completionverifier | 309 B | 255 tok | 347 B | 268 tok |
| budgetestimator | 233 B | 286 tok | 277 B | 274 tok |

That's ~520-560 tokens of genuinely new content per task, driven by the tool
round trips — smaller in absolute terms than the pre-fix path (which, per
`turn-count-investigation.md`, included a failed guessed-`symbol_id` call
*and*, for completionverifier, a full `Read` of the file plus a `Grep` across
`src/` as fallback — both far larger payloads than a two-match JSON blob).

## So where did the extra tokens come from? A caching-locality artifact, not a payload regression

The `RESULT` event for each of my two runs:

| Run | turns | cost | input | output | cacheCreation | cacheRead |
|---|---|---|---|---|---|---|
| completionverifier (run 1) | 3 | $0.115 | 6 | 215 | **16901** | 33011 |
| budgetestimator (run 2, ~3 min later) | 3 | $0.038 | 6 | 296 | **3188** | 46792 |

Same g-mesh version, same clean 2-tool-call shape, same tool-payload sizes
(similar table above) — yet `cacheCreationTokens` differs by **5.3x** between
these two runs of mine. The reason is visible in the raw usage blocks: run 1's
very first turn pays `cache_creation_input_tokens: 16378` (a full fresh
Anthropic-API cache write of the system prompt + tool schemas, tagged
`ephemeral_1h_input_tokens`, because nothing matching that exact prefix was
cached yet). Run 2's first turn instead shows `cache_read_input_tokens: 13750`
+ `cache_creation_input_tokens: 2628` — most of that same prefix was already
warm in the 1h ephemeral cache from run 1, so run 2 only pays for the small
diverging tail.

This is the exact same shape as the original anomaly: whether a given
benchmark run's `cacheCreationTokens` is dominated by a ~16-17k-token
system-prompt cache miss, or reduced to a few thousand (or a few hundred) by
inheriting a warm cache from a preceding call with an identical prefix,
depends entirely on **timing and call order relative to the 1h ephemeral
cache window** — not on anything g-mesh returns. `token-economy.ts` runs 5
tasks × 2 arms (gmesh, baseline) in sequence per corpus; the two
`find_implementations` tasks are 3rd/4th and 5th/6th in that sequence with a
different-tool-schema baseline-arm call interleaved between them. Whether
each one's system-prompt prefix happens to still be warm from an earlier
gmesh-arm call in the same batch — or from unrelated interactive `claude`
usage on the same machine minutes before the benchmark started — is exactly
the kind of cross-run confound that can produce a 1000+-token swing in either
direction between two separate batch executions (the pre-fix batch at 20:44
and the post-fix batch at 21:58, ~74 minutes apart), with zero relation to
tool-payload size or query shape.

The originally observed deltas (2115→3154, 2035→3168 — roughly +1000-1100
tokens each) are well within the range this locality effect alone produces
(I saw a ~13700-token swing between two consecutive runs of my own, from
cache locality alone). Given the *actual* tool payloads are small and, if
anything, cleaner/smaller post-fix than pre-fix, there's no basis to attribute
the original increase to a g-mesh response-size or query-shape regression.

## Conclusion

**No confirmed g-mesh regression. Closing as no-bug per the acceptance
criteria** (fix only if a concrete regression is confirmed — it isn't).

- `find_definition`, `find_implementations` payloads are small (233-347
  bytes) and unchanged in shape/size between the two tasks; nothing here
  points at `find_definition.rs`, `find_file_outline.rs`, or
  `find_implementations.rs` being heavier post-fix.
- The turn-count improvement (5→3) is real and durable — confirmed again in
  this fresh trace, and it's now via the fully-successful g-mesh path
  (`find_definition` → `find_implementations`), not a grep fallback.
- The token increase reported in `v0.1.1-postfix-rerun.md` is best explained
  by Anthropic prompt-cache locality/timing between two separate benchmark
  batch executions (system-prompt/tool-schema cache hit vs. miss, worth
  ~13-16k tokens either way), not by anything g-mesh returned differently.

### Follow-up worth filing (not implemented here, methodology only)

The benchmark's `cacheCreationTokens` metric is not a reliable before/after
signal at n=1 because of this cache-locality confound — it can swing by an
order of magnitude between runs with identical tool behavior depending on
what else shared the API key's cache in the preceding ~1h. Suggestions for
`report.ts`/`token-economy.ts`, for whoever picks this up:
- Track something locality-insensitive as the primary token metric — e.g. sum
  of tool-result byte sizes captured directly from a stream-json run, or
  `cacheCreationTokens` minus an estimated fixed system-prompt-prefix size.
- Or force a controlled cache state before each measured run (e.g. a warm-up
  call per arm immediately before the timed one, so every run in a comparison
  starts from the same hit/miss condition).
- At minimum, always run token-economy comparisons back-to-back in the same
  process invocation (not separate `main()` runs an hour+ apart) to keep
  cache-locality conditions as similar as possible between "before" and
  "after" samples.
