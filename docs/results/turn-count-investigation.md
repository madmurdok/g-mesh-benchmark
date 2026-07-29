# Turn-count investigation

Re-ran the 3 highest-turn-count gmesh-arm tasks from the v0.1.0 run with
`claude -p --output-format stream-json` to capture the actual tool-call
sequence (the saved results only had the final answer, not the turn-by-turn
log). Answer to the original question: **the extra turns are not the agent
making redundant/duplicate calls where one would do — they're retries forced
by concrete g-mesh bugs/API gaps**, category (c) from the investigation task,
plus one real correctness bug (category d).

## `tt-find-impl-completionverifier` (5 turns)

1. `find_definition("CompletionVerifier")` → returns `qualifiedName` +
   `filePath` for two matches, **no `symbolId` field**.
2. Agent guesses a symbol_id format: `find_implementations({symbol_id:
   "src/domain/verification.ts#CompletionVerifier"})` → **errors**: "no
   symbol with id ... found". The guessed format is wrong.
3. Falls back to `Read` the file directly.
4. Falls back to `Grep` across `src/` for the interface name.
5. Answers correctly from the grep+read fallback (g-mesh's real answer was
   never actually obtained here).

## `tt-find-impl-budgetestimator` (5 turns)

Same shape, but this time the agent recovers *through g-mesh* instead of
falling back to grep:

1. `find_definition("BudgetEstimator")` → `qualifiedName` + `filePath`, no
   `symbolId` again.
2. Guessed `symbol_id: "src/domain/budget.ts#BudgetEstimator"` →
   `find_implementations` **errors**, same as above.
3. `get_file_outline("src/domain/budget.ts")` → **this** tool does return
   real `symbolId`s (opaque hashes, e.g. `"106681c854ddeb35ded61a62df62e6d5"`).
4. `find_implementations({symbol_id: <real id from step 3>})` → **succeeds**,
   returns `HeuristicBudgetEstimator`.
5. Answers correctly, this time from g-mesh's real data.

**Root cause, both tasks**: `find_definition`'s result schema gives
`qualifiedName`/`filePath` but not the `symbolId` needed to chain into
`find_implementations`/`find_references`/`find_callers`. The agent has no way
to get a valid id except by guessing (wrong) or taking a detour through
`get_file_outline` (which does return real ids). **Fix**: have
`find_definition` include `symbolId` in each result, matching what
`get_file_outline` already returns.

## `tt-references-requiretask` (7 turns)

1. `find_definition("requireTask")` → same missing-`symbolId` issue, plus
   more duplicate entries (see below).
2. Agent tries `find_definition({file_path, symbol_name})` as a combo →
   **errors**: `"file_path and position must be given together"` — an
   unsupported parameter combination.
3. `get_file_outline("src/domain/tasks.ts")` → gets a real `symbolId`.
4. `find_callers({symbol_id: <real id>})` → **succeeds**, finds `setTaskPriority`
   and `splitTask` as in-file callers.
5. `find_references({symbol_id: <same id>})` → **returns an empty result**
   (`{"results":[],"hasMore":false,"nextCursor":null}`), despite
   `find_callers` finding real callers for the identical id one step earlier.
   **This is a genuine g-mesh correctness bug**, not just an API-shape
   issue — `find_references` and `find_callers` disagree on the same symbol.
6. Falls back to `Grep` for `requireTask` across `src/**`, finds the real
   answer (`tasks.ts`, `status.ts`, `releases.ts`).
7. Answers from the grep fallback.

## Secondary finding: stale `.claude/worktrees/` duplicates in the index

All three `find_definition` calls returned extra matches from paths like
`.claude/worktrees/agent-<hash>/src/domain/...` — stale copies of the same
files living under a Claude Code worktree directory inside the
`task-tracker-mcp` repo. g-mesh's README says its bulk index walk is
"gitignore-aware, skipping `.git`, `node_modules` and `dist`" — `.claude/worktrees`
isn't in that skip list, so these duplicate/stale entries pollute
`find_definition` results with noise (extra results to read past, though not
what caused the extra turns here).

## Conclusion

Not an inefficiency in how the *agent* uses g-mesh's tools — it degrades
sensibly (id-guess fails → get_file_outline → retry, or → grep fallback) each
time it hits a real gap. Two concrete, fixable issues in **g-mesh itself**:

1. `find_definition` should return `symbolId` per result (like
   `get_file_outline` does) so agents don't need a detour to chain into
   `find_implementations`/`find_references`/`find_callers`.
2. `find_references` returned empty for a symbol where `find_callers` found
   real results on the identical id — a correctness bug worth its own
   investigation in the g-mesh project, not the benchmark.
3. (Minor) the bulk-index walk appears to index `.claude/worktrees/` copies;
   worth confirming whether that's intended.
