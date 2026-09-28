# tool-use-logger — GMB-177

A `PostToolUse` hook that appends one JSONL record per tool call, so future
tool-surface changes to g-mesh (and to CLAUDE.md's routing guidance) can be
argued from measured real-session use instead of intuition. Background and
constraints: GMB-177.

## Install

This repo never writes to `~/.claude/` itself — that is the user's global
config. Install it yourself:

```
bash scripts/install-tool-use-hook.sh
```

This copies `hooks/tool-use-logger.mjs` to `~/.claude/hooks/` and prints the
`settings.json` fragment to wire it into `PostToolUse`. It does **not** touch
`settings.json` — merge the printed fragment into your existing `"hooks"`
object by hand (this machine's `SubagentStop`/`Stop` entries for
`task-handoff-check.sh` must stay). Override `$HOME` to install somewhere
else, e.g. for testing:

```
HOME=/tmp/fake-home bash scripts/install-tool-use-hook.sh
```

## What one record captures, and why

```json
{
  "ts": "2026-09-22T16:58:41.981Z",
  "session_id": "4685644a-...",
  "tool_name": "mcp__g-mesh__find_references",
  "args_summary": "{\"symbol_name\":\"computeTokenSpread\"}",
  "response_bytes": 162,
  "error": false,
  "markers": { "resolvedBy": "id", "hasMore": false, "filesPresent": true }
}
```

- **`ts`, `session_id`** — needed to reconstruct chronological per-session
  sequences for cut 1 (length-2/3 frequencies), and to tell repeated calls
  within a short window apart from ones in a different session.
- **`tool_name`** — per-tool counts, and the unit sequences are built from.
- **`args_summary`** — a *redacted, truncated* summary of `tool_input`, not
  the raw object. Keys that can hold whole file/code content (`content`,
  `new_string`, `old_string`, `file_text`, `patch`, `diff`, `body`, `prompt`,
  …) are replaced with `"<redacted:NNb>"` — a byte count, never the value,
  regardless of how short it is (a short file is still a whole file). The
  remaining JSON is then truncated to 500 characters. This still lets the
  analysis see tool identifiers, symbol names, flags like `direction` or
  `transitive`, and short commands — enough to build sequences and detect
  rule-firing patterns, without ever carrying prose, code, or file bodies.
- **`response_bytes`** — the byte length of `JSON.stringify(tool_response)`.
  Feeds the response-size distribution (cut 1) and, combined with `error`,
  the g-mesh-miss detector (cut 2). Never the response content itself.
- **`error`** — a boolean read off known error shapes (`isError`, `is_error`,
  `error`, or an MCP `content[].isError`). Used directly by the acceptance
  criteria and by the "fall back to grep after a g-mesh miss" rule detector.
- **`markers`** *(only for `mcp__g-mesh__*` tools)* — a handful of
  **structural** booleans/short enum strings regex-scanned out of the
  response text: `ambiguous`, `resolvedBy`, `truncated`, `truncatedBy`,
  `allUnresolved`, `hasMore`, `hasUnresolvedRow`, `filesPresent`. These are
  exactly the fields CLAUDE.md's "Code search" section tells the agent to
  read before trusting a result — they exist so cut 2 can measure how often
  each situation those rules govern actually arose, without ever writing the
  response body (which could contain file paths, symbol names from the
  user's own code, or search result text) to disk. The scan is regex over
  the response's own already-serialized text, held in memory only for the
  duration of one hook invocation.

### What was deliberately left out, and why

- **The rest of `tool_input`/`tool_response`** — see above; whole values are
  never logged, only redacted/truncated summaries and byte counts.
- **`cwd`, `transcript_path`** — Claude Code's `PostToolUse` payload includes
  these, but they can embed the real username and local directory layout.
  Nothing in either analysis cut needs them (`session_id` already scopes a
  session), so they are never read into the record.
- **`prompt_id`, `permission_mode`, `effort`** — not needed for tool-use
  analysis; omitting them also means the hook doesn't couple itself to
  fields whose shape Claude Code could change in a future hook-contract
  revision (the hook already treats any missing/renamed field leniently and
  degrades to silence rather than throwing — see below).
- **Any assistant text or reasoning** — a `PostToolUse` hook only ever sees
  one tool call and its result; it never receives the model's turn text.
- **Markers for non-g-mesh tools** — even if a `Bash` command's stdout
  happens to contain text shaped like `"resolvedBy":"id"`, the hook never
  scans it, because the scan only runs when `tool_name` starts with
  `mcp__g-mesh__`. Verified by
  `hooks/tool-use-logger.test.mjs`'s "never attaches markers for a
  non-g-mesh tool" test.

## Privacy, stated plainly

Of the user's actual code, file contents, or prompts: **none of it** reaches
the log. What does reach it: tool names, timing, byte counts, a truncated
and content-redacted JSON summary of each call's arguments (identifiers,
flags, short commands — not file bodies), whether a call errored, and — for
g-mesh calls only — a handful of structural true/false/short-enum markers
already named in CLAUDE.md's own guidance (not the underlying text those
markers were found in).

## Failure degrades to silence

The entire hook runs inside one `try`/`catch`; on **any** failure (malformed
stdin, an unwritable or non-creatable log directory, a serialization error)
it exits `0` with no stdout and no stderr. A `PostToolUse` hook that crashes
or times out cannot block or retroactively fail the tool call it's observing
— the call already completed — but a hook that throws visibly or writes to
stderr still adds noise to a session, which this avoids outright.

Demonstrated in `hooks/tool-use-logger.test.mjs`:
`node --test hooks/tool-use-logger.test.mjs`. Two tests point the log path at
a `chmod 555` (read-only) directory — one directly, one nested under a
non-creatable parent chain — and assert exit code `0`, empty stdout/stderr,
and that nothing was written.

## Analysis

```
npx tsx scripts/analyzeToolUseLog.ts <path-to-tool-use-log.jsonl> [--claude-md <path>]
```

`--claude-md` defaults to `~/.claude/CLAUDE.md` (read-only — sizes the "Code
search" section for cut 2's arithmetic; never written to). Two cuts:

1. **Sequences** — per-tool call counts, length-2/3 sequence frequencies
   (within a session only), and a response-size distribution reported as a
   spread (`min–max (n=N)` plus p25/p50/p75/p90), following the `TokenSpread`
   shape in `harness/lib/reportData.ts` (GMB-117) rather than a bare median.
2. **Rule firing rates** — for each routing rule in CLAUDE.md's "Code
   search" section, whether it's observable from a tool-call log at all
   (`yes`/`partial`/`no`, with the reason), and if so, how often its
   situation arose in this log, plus the prompt-cost-per-turn vs.
   one-wasted-round-trip arithmetic for that rule.

**The output states its own limit, not just this README:** real sessions
have no oracle and no control arm, so every number is descriptive (what
occurred, how often) and none of it is evaluative ("X is better", "rule Y is
wrong"). This is printed at both the top and bottom of the script's own
output.
