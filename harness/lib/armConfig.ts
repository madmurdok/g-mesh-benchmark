import type { CustomArmDefinition } from "./benchConfig.js";
import { loadBenchConfig } from "./benchConfig.js";
import type { McpServerConfig } from "./mcpConfig.js";
import { buildBaselineArmConfig, buildGmeshArmConfig, buildKungfuArmConfig } from "./mcpConfig.js";
import type { Arm, BuiltinArm } from "./types.js";

/**
 * The `claude -p` configuration that defines an arm — model, per-call budget
 * cap, tool list, MCP config and prompt shaping.
 *
 * Extracted verbatim out of token-economy.ts when session-economy.ts needed
 * the *same* arm definitions: two experiments comparing gmesh against baseline
 * have to hold the arms byte-for-byte identical, or their numbers aren't
 * comparable with each other. Deliberately excludes each entrypoint's own
 * env-var gates and preflight checks, which stay duplicated per entrypoint
 * (matching this codebase's existing precedent).
 */
export const MODEL = "claude-sonnet-5";
export const MAX_BUDGET_USD = 2.5;
export const GMESH_TOOLS = "Read,Grep,Glob,mcp__g-mesh__*";
export const BASELINE_TOOLS = "Read,Grep,Glob";

/**
 * kungfu exposes 40 MCP tools; a bare `mcp__kungfu__*` wildcard would compare
 * a much larger tool-schema surface than g-mesh's 7, confounding "retrieval
 * quality" with "schema-tax" (see docs/results/v0.2.0-session-economy-findings.md
 * on schema-tax being real and measurable). This curated subset targets the
 * closest kungfu analog to each of g-mesh's 7 tools, confirmed against a live
 * `tools/list` probe of kungfu v2.6.2:
 *
 *   g-mesh tool          -> kungfu tool      | fit
 *   find_definition       -> find_symbol      | good (name lookup)
 *   find_callers          -> callers          | good (call-graph, exact)
 *   find_callees          -> callees          | good (call-graph, exact)
 *   get_file_outline      -> file_outline     | good (exact)
 *   find_references       -> search_text      | approximate: kungfu has no
 *       distinct "all usages of this symbol" tool separate from the call
 *       graph — search_text is a text/regex search, not a resolved-symbol
 *       reference walk, so it will both over- and under-match relative to
 *       find_references.
 *   get_dependencies      -> affected         | approximate: "affected" is a
 *       transitive-callers blast-radius walk over the call graph, not an
 *       import/module dependency graph — there is no g-mesh-style
 *       get_dependencies analog in kungfu at all.
 *   find_implementations   -> (none)           | gap: kungfu has no
 *       interface/supertype-implementation tool in its 40-tool surface.
 *       Left out of the curated set entirely rather than mapped to something
 *       misleading.
 *
 * find_implementations has no kungfu analog and is dropped rather than
 * mapped to a poor substitute, so this arm runs 6 tools against g-mesh's 7 —
 * documented here, not silently normalized away.
 */
export const KUNGFU_TOOLS =
  "Read,Grep,Glob,mcp__kungfu__find_symbol,mcp__kungfu__callers,mcp__kungfu__callees," +
  "mcp__kungfu__file_outline,mcp__kungfu__search_text,mcp__kungfu__affected";

/**
 * `--tools` (the `KUNGFU_TOOLS` constant above) only restricts the *built-in*
 * tool set (Read/Grep/Bash/etc.) — confirmed via `claude -p --help` and live
 * transcripts of a kungfu-arm run showing calls to `mcp__kungfu__semantic_search`
 * and `mcp__kungfu__find_files`, neither of which is in `KUNGFU_TOOLS`. It has
 * zero effect on `mcp__`-namespaced tools, so every historical kungfu-arm run
 * in this project actually measured kungfu's full 40-tool surface, not the
 * intended curated 6.
 *
 * The only mechanism that actually shrinks what's sent to the model is a
 * `--disallowedTools` *deny* rule (confirmed against `code.claude.com/docs/en/permissions`:
 * "A bare tool name... removes the tool from Claude's context entirely, so
 * Claude never sees it" — allow rules never do this, and this holds regardless
 * of `--permission-mode bypassPermissions`, which only skips permission
 * *prompts*, a separate and later mechanism). kungfu has no tool-subset config
 * of its own, so this is the only available fix: enumerate every kungfu tool
 * *not* in the curated set and deny it explicitly.
 *
 * Captured via a live `tools/list` probe against `kungfu mcp` v2.6.2 — the
 * same version `KUNGFU_TOOLS`'s own doc comment cites — and is every kungfu
 * tool except the curated 6 in `KUNGFU_TOOLS` above. Like `KUNGFU_TOOLS`
 * itself, this is unvendored third-party surface: if kungfu's own tool set
 * ever changes, this list must be regenerated (re-run the probe, diff against
 * `KUNGFU_TOOLS`) rather than assumed still accurate.
 */
export const KUNGFU_DENIED_TOOLS =
  "mcp__kungfu__annotate_file,mcp__kungfu__annotation_queue,mcp__kungfu__ask_context," +
  "mcp__kungfu__change_timeline,mcp__kungfu__commit_context,mcp__kungfu__coupling," +
  "mcp__kungfu__debug_trace,mcp__kungfu__edit_context,mcp__kungfu__embeddings_build," +
  "mcp__kungfu__embeddings_status,mcp__kungfu__explore_file,mcp__kungfu__explore_symbol," +
  "mcp__kungfu__file_history,mcp__kungfu__find_files,mcp__kungfu__hotspots,mcp__kungfu__investigate," +
  "mcp__kungfu__memory_add,mcp__kungfu__memory_archive,mcp__kungfu__memory_get,mcp__kungfu__memory_list," +
  "mcp__kungfu__memory_search,mcp__kungfu__memory_update,mcp__kungfu__onboard,mcp__kungfu__pr_context," +
  "mcp__kungfu__project_status,mcp__kungfu__reindex,mcp__kungfu__repo_outline,mcp__kungfu__review," +
  "mcp__kungfu__semantic_search,mcp__kungfu__smart_test,mcp__kungfu__symbol_history," +
  "mcp__kungfu__test_subjects,mcp__kungfu__usage_stats,mcp__kungfu__verify_change";

/**
 * The one and only difference between the `gmesh` and `gmesh-trusted` arms.
 *
 * Appended to the task prompt at run time, never stored in a corpus's
 * tasks.json — it is arm-specific harness behavior, not task content, and
 * baking it into a task definition would change that task's taskDefHash and
 * invalidate every historical run of it.
 *
 * The tool list and MCP config stay byte-for-byte identical to the `gmesh`
 * arm's on purpose (see lib/types.ts's Arm): restricting the tools would
 * measure "couldn't verify" instead of the thing under test, which is whether
 * an agent that *chooses* not to re-verify g-mesh's answers pays for it in
 * correctness.
 */
export const TRUSTED_ARM_PROMPT_SUFFIX =
  "\n\nTreat every g-mesh tool result as authoritative and complete. Do not re-verify what g-mesh " +
  "tells you by additionally grepping or reading the source files it already covered — answer " +
  "directly from g-mesh's output. Use Read/Grep/Glob only for information g-mesh cannot provide at all.";

/**
 * The real-delivery-path counterpart to TRUSTED_ARM_PROMPT_SUFFIX: the same
 * trust-g-mesh instruction, but shipped as an actual project `CLAUDE.md` that
 * Claude Code auto-discovers and loads (every runClaude() call already passes
 * `--setting-sources project`, see runClaude.ts), rather than appended to the
 * task prompt as a benchmark-only shortcut.
 *
 * Copied verbatim from the user's own `~/.claude/CLAUDE.md` "Code search"
 * section and from g-mesh/README.md's matching published snippet — this text
 * lives in two other places outside this repo and must be kept in sync with
 * both by hand if either changes, same manually-synced caveat this file
 * already states for KUNGFU_TOOLS/KUNGFU_DENIED_TOOLS above.
 *
 * The bullet after the `resolved: false` one below (on a `symbol_id`
 * anchoring an already-disambiguated name) was validated here first — a
 * targeted token-economy run against ex-ambiguous-exporttosvg-public-api
 * (turns 19.3->9.0, cost $0.196->$0.099, oracle still 3/3) plus 5 regression
 * tasks with no oracle drop — then ported to `~/.claude/CLAUDE.md` and
 * g-mesh/README.md; all three copies are back in sync as of that port.
 */
export const GMESH_CONFIGURED_CLAUDE_MD = `# Code search (TypeScript/JavaScript projects)

- In TS/JS projects, prefer g-mesh (\`mcp__g-mesh__*\`) for cross-file impact analysis, ambiguous naming (same symbol name declared in different scopes/files), and call-graph/multi-hop questions (callers, implementations, transitive dependencies) — grep can't resolve these reliably and has real unbounded cost (many round-trips, occasionally very expensive) when it tries. For simple, unambiguous single-symbol lookups, grep/\`Explore\`/manual reading is often just as fast and cheaper — g-mesh's tool schema adds fixed overhead per turn that doesn't pay for itself on easy questions (measured: g-mesh costs *more* tokens than grep on simple lookups, both isolated and in a long session — see \`g-mesh-bench/docs/results/v0.2.0-session-economy-findings.md\`). Fall back to grep when g-mesh returns no result, errors, or the target isn't something it tracks (non-code files, config, CSS, etc.).
- No manual indexing command exists or is needed. The g-mesh daemon bootstraps and indexes a project automatically on its first tool call in that project's directory. On first use in a new project, just issue any g-mesh call (e.g. \`get_file_outline\` on a source file) to trigger indexing, then proceed.
- How to use the tools:
  - \`get_file_outline(file_path)\` — list a file's top-level symbols before reading it in full, or to find the right symbol name to query next.
  - \`find_definition(symbol_name)\` or \`find_definition(file_path, position)\` — resolve a symbol to its definition and get its \`symbol_id\`. Not required before the tools below — they accept \`symbol_name\` directly and skip this call when the name is likely unambiguous, saving a round-trip. Call \`find_definition\` first only when you already expect ambiguity or need the declaration site itself.
  - \`find_references(symbol_name or symbol_id)\` — every usage of a symbol across the project; use before renaming or removing something.
  - \`find_callers(symbol_name or symbol_id)\` / \`find_callees(...)\` — walk the call graph up or down from a function.
  - \`find_implementations(symbol_name or symbol_id)\` — concrete types implementing an interface/abstract class.
  - \`get_dependencies(file_path, direction: Outgoing|Incoming)\` — walk the import graph (what a file imports / what imports it); use for impact analysis before changing a shared module.
  - If a \`symbol_name\` turns out ambiguous, the result carries \`ambiguous: true\` with a ranked candidate list — re-query using a candidate's \`id\` as \`symbol_id\`, not its \`qualifiedName\` (the same qualifiedName can name more than one declaration).
- Typical flow: call \`find_references\`/\`find_callers\`/\`find_callees\`/\`find_implementations\` directly with \`symbol_name\` when it's likely unique; only call \`find_definition\` first if you expect ambiguity or need the declaration site itself. Use \`get_file_outline\` first if you don't already know the right symbol name.
- A \`find_references\`/\`find_callers\`/\`find_callees\`/\`find_implementations\` result is complete for the question it answers when: it was anchored by \`symbol_id\` or an unambiguous \`symbol_name\` (same guarantee either way), every row shows \`resolved: true\`, and the response has no \`allUnresolved: true\` flag — don't re-verify that with grep/Read. As of g-mesh 0.8.x, \`resolved: false\` is a narrow, accurate signal (only edges whose target is in another file g-mesh couldn't confirm — same-file edges are always \`resolved: true\`, matched against declarations actually in scope), not a blanket disclaimer, so still check: a row that shows \`resolved: false\` (check that row, not the whole list), a response with \`allUnresolved: true\` (the whole page is unconfirmed), or anything the result doesn't claim to cover at all — e.g. whether other, similarly-named symbols exist elsewhere, or a method call reached through a variable receiver (\`x.foo()\`, which produces no edge by design). Measured on real g-mesh-bench runs after the 0.8.x same-file-resolution fix: mean cost dropped ~38% and mean turns ~35% on the task this was tested on, with the remaining tool calls answering things g-mesh genuinely doesn't cover rather than re-checking it (see g-mesh's README "Reducing self-verification cost" section) — but grep/Read still earn their keep on the cases above, so don't suppress those.
- Resolving an ambiguous name (the bullet above on \`ambiguous: true\` candidates) to a specific \`symbol_id\` doesn't reopen the completeness question: a \`find_references\`/\`find_callers\`/\`find_callees\`/\`find_implementations\` page anchored by that \`symbol_id\` carries the exact same \`resolved: true\`/no-\`allUnresolved\` guarantee as an unambiguous \`symbol_name\` query. Once you've picked the right candidate, treat its result as final — don't grep/Read each returned call site file-by-file to reconfirm it's "really" that symbol and not the same-named other one, and don't run a second, broad text search across the repo to check for anything the query might have missed. Both duplicate work the tool has already resolved, the same way re-verifying a plain unambiguous result would.
- \`find_implementations\` only returns direct implementors/extenders by default — a class extending a class that implements the anchor interface won't show up in a \`hasMore: false\` page. For the whole hierarchy, re-call with \`transitive: true\` (walks the same edges transitively, up to a bounded depth, resumable via \`resume_token\`).
`;

/**
 * The kungfu-side counterpart to GMESH_CONFIGURED_CLAUDE_MD: kungfu's own
 * documented recommendation for how an agent should use it, copied verbatim
 * (not paraphrased) from github.com/denyzhirkov/kungfu's README, "Manual
 * setup (advanced / other agents)" section — so any gmesh-configured vs
 * kungfu comparison is best-practice-vs-best-practice instead of g-mesh's
 * tuned setup against kungfu with no setup guidance at all.
 *
 * Deliberately kept verbatim even though it references kungfu tools
 * (ask_context, investigate, explore_symbol, explore_file, edit_context,
 * file_history, symbol_history, change_timeline, coupling, smart_test,
 * hotspots, debug_trace, reindex, verify_change, memory_search, memory_add)
 * well outside KUNGFU_TOOLS's curated 6-tool allowlist that the
 * kungfu/kungfu-configured arms are restricted to via KUNGFU_DENIED_TOOLS.
 * The point is testing kungfu's own real recommendation as written, not a
 * version edited to match this benchmark's restriction — mismatched tool
 * references are a fair, honest side effect of the same restriction that
 * makes the kungfu arm comparable to g-mesh's 6-7 tools at all.
 */
export const KUNGFU_CONFIGURED_CLAUDE_MD = `## kungfu — context retrieval (use BEFORE Read / grep / find)

Default to kungfu; raw file reads are the fallback, not the first move — it returns
ranked, scoped packets instead of whole files. Start every task with
\`ask_context("<task>", budget: "tiny")\` and escalate the budget only if the packet
is clearly insufficient. Open a raw file only once kungfu points you at it.

Route by situation:

| Situation | First call |
|---|---|
| New task / "figure out X" | \`ask_context\` (or \`investigate\`) |
| Where is a named symbol defined/used? | \`find_symbol\` → \`explore_symbol\`, then \`callers\` / \`callees\` |
| Concept with no known name ("where does rate limiting live") | \`semantic_search\` |
| Understand a file > 50 lines | \`file_outline\` / \`explore_file\`, then a targeted Read of that range |
| About to edit a symbol | \`edit_context\` (full verbatim body + contracts — no follow-up Read) |
| "Why is it like this / what changed?" | \`file_history\` / \`symbol_history\` / \`change_timeline\` |
| Refactor touching > 1 file | \`affected\` + \`coupling\` + \`smart_test\` before editing |
| Bug with no clear file | \`hotspots\`, then \`debug_trace\` on the stack trace |

After edits: \`reindex\` the changed paths, then \`verify_change\` for the blast radius
and minimal test set. \`memory_search\` before implementing (there may already be a
decision or warning); \`memory_add\` to persist new ones — pin sparingly.

Skip kungfu only for: a one-line edit in a file already open this session; a file
< 50 lines whose exact path you know; pure shell ops; reading a config/lock file by
exact path. Otherwise, if you reach for Read / grep / find — stop and route above.
`;

/**
 * Everything `claude -p` needs to know about one arm, in one place.
 *
 * Split out of what used to be three separate if/else chains (armMcpConfig,
 * armTools, armDisallowedTools) all keyed on the same `Arm` union: adding an
 * arm meant remembering to touch each of them, and a per-arm dispatch spread
 * across N functions is exactly the shape that lets an arm be added — or
 * swapped — in some places and forgotten in others.
 */
export interface ArmDefinition {
  /**
   * A factory, not a value: buildGmeshArmConfig()/buildKungfuArmConfig() read
   * their binary path from the environment at call time (see mcpConfig.ts's
   * gmeshBinaryPath/kungfuBinaryPath), and every caller has always received a
   * freshly built object it may mutate.
   */
  mcpConfig: () => McpServerConfig;
  /** `--tools` allow list; built-in tools only, see KUNGFU_DENIED_TOOLS on why that isn't enough for MCP tools. */
  tools: string;
  /** `--disallowedTools` deny list; omitted for arms that need no tool removed from the model's context. */
  disallowedTools?: string;
  /** Appended to the task prompt by armPrompt(); omitted for arms that run the prompt verbatim. */
  promptSuffix?: string;
}

/**
 * gmesh-trusted and gmesh-configured deliberately share the gmesh arm's tools
 * and MCP config; only the prompt (gmesh-trusted) or the loaded CLAUDE.md
 * (gmesh-configured, handled by corpusResolver.ts via the run's cwd, not here)
 * differs. Sharing one base definition rather than repeating the fields is
 * what makes that guarantee structural: the tool list and MCP config *cannot*
 * drift apart, which is the property lib/types.ts's Arm doc claims for
 * gmesh-trusted ("byte-for-byte the same MCP config and tool list as gmesh").
 */
const GMESH_ARM: ArmDefinition = {
  mcpConfig: buildGmeshArmConfig,
  tools: GMESH_TOOLS,
};

/** Same story for kungfu-configured vs kungfu: identical tools/MCP config, only the loaded CLAUDE.md (and thus cwd) differs. */
const KUNGFU_ARM: ArmDefinition = {
  mcpConfig: buildKungfuArmConfig,
  tools: KUNGFU_TOOLS,
  disallowedTools: KUNGFU_DENIED_TOOLS,
};

/**
 * The single table every per-arm accessor below reads from. Adding a *built-in*
 * arm is one entry here plus the `BuiltinArm` union and ARM_ORDER in
 * lib/types.ts — the `Record<BuiltinArm, ...>` makes a missing entry a type
 * error rather than a silent fall-through to whatever the old chains' default
 * branch happened to be.
 *
 * Keyed by `BuiltinArm`, not `Arm`: an arm registered in
 * g-mesh-bench.config.json's `customArms` is by definition not known here and
 * is resolved by the accessors' fallback below (customArmDefinition()). The
 * exhaustiveness guarantee is therefore still exactly as strong as it was —
 * it just no longer claims to cover names that only exist at runtime.
 */
export const ARM_DEFINITIONS: Record<BuiltinArm, ArmDefinition> = {
  gmesh: GMESH_ARM,
  baseline: {
    mcpConfig: buildBaselineArmConfig,
    tools: BASELINE_TOOLS,
  },
  "gmesh-trusted": { ...GMESH_ARM, promptSuffix: TRUSTED_ARM_PROMPT_SUFFIX },
  kungfu: KUNGFU_ARM,
  "gmesh-configured": GMESH_ARM,
  "kungfu-configured": KUNGFU_ARM,
};

/**
 * Appended to whatever the arm's normal tool list is when a task actually has
 * to change code (`oracle.mode === "test"`). Every arm gets the identical
 * addition, so the gmesh-vs-baseline comparison still differs only in search
 * tooling.
 *
 * `Bash` is deliberately not included. With it, an agent can run the corpus's
 * test suite in a loop until it goes green, and the measurement stops being
 * "did better code search produce a correct edit" and becomes "how many
 * self-test iterations did each arm burn" — a different experiment, with much
 * higher and much noisier cost. Worth revisiting as a separate arm one day,
 * but not as a silent property of this one.
 */
export const EDIT_TOOLS = "Edit,Write";

export interface ArmToolsOptions {
  /** Grant EDIT_TOOLS on top of the arm's normal list — set for `oracle.mode === "test"` tasks only. */
  allowEdit?: boolean;
}

/**
 * The built-in definition for `arm`, or undefined if the name isn't one of
 * ARM_DEFINITIONS' own keys — the single membership test every accessor below
 * branches on, so "built-in first, config-registered second" is decided in one
 * place rather than four.
 *
 * `hasOwnProperty` rather than `arm in ARM_DEFINITIONS`: `in` also answers yes
 * for inherited Object.prototype members, so a custom arm unluckily named
 * "constructor" or "toString" would otherwise resolve to a prototype value
 * instead of falling through to the config.
 */
function builtinArmDefinition(arm: Arm): ArmDefinition | undefined {
  return Object.prototype.hasOwnProperty.call(ARM_DEFINITIONS, arm)
    ? ARM_DEFINITIONS[arm as BuiltinArm]
    : undefined;
}

/**
 * Resolves an arm that isn't built in against g-mesh-bench.config.json's
 * `customArms` (see benchConfig.ts's CustomArmDefinition), so a new MCP-based
 * comparison arm needs a config entry and no source change at all.
 *
 * Throws naming *both* places an arm can be defined: by the time an arm name
 * reaches here it has already passed benchConfig.ts's validateArms(), so
 * getting this error means the caller invented an arm name in code, or the
 * config file it was validated against isn't the one loaded here.
 */
function customArmDefinition(arm: Arm): CustomArmDefinition {
  const def = loadBenchConfig().customArms[arm];
  if (def === undefined) {
    throw new Error(
      `Unknown arm "${arm}": it is neither a built-in arm (${Object.keys(ARM_DEFINITIONS).join(", ")}) ` +
        `nor registered under "customArms" in g-mesh-bench.config.json.`,
    );
  }
  return def;
}

export function armMcpConfig(arm: Arm): McpServerConfig {
  const builtin = builtinArmDefinition(arm);
  if (builtin !== undefined) return builtin.mcpConfig();
  const def = customArmDefinition(arm);
  // The arm name *is* the MCP server name, which is what makes the arm's
  // tools `mcp__<arm>__…` — the same names its `tools`/`deniedTools` lists
  // spell out. Freshly built (args copied, not aliased) for the same reason
  // the built-in factories are: callers have always been free to mutate it.
  return { mcpServers: { [arm]: { command: def.command, args: [...def.args] } } };
}

export function armTools(arm: Arm, opts: ArmToolsOptions = {}): string {
  const builtin = builtinArmDefinition(arm);
  // Read/Grep/Glob (BASELINE_TOOLS) are prepended rather than expected in the
  // config: every arm in this benchmark has them, including baseline, so a
  // custom arm listing them again would only duplicate entries.
  const base =
    builtin !== undefined ? builtin.tools : `${BASELINE_TOOLS},${customArmDefinition(arm).tools.join(",")}`;
  return opts.allowEdit ? `${base},${EDIT_TOOLS}` : base;
}

export function armPrompt(prompt: string, arm: Arm): string {
  // Custom arms get no suffix: the trusted-variant idea (TRUSTED_ARM_PROMPT_SUFFIX)
  // is written about g-mesh specifically, and there is no per-arm prompt
  // shaping in the config surface for a custom arm to opt into.
  const builtin = builtinArmDefinition(arm);
  if (builtin === undefined) {
    // Still resolved, not skipped: an unregistered arm must fail here too,
    // rather than quietly running with an unmodified prompt.
    customArmDefinition(arm);
    return prompt;
  }
  const suffix = builtin.promptSuffix;
  return suffix === undefined ? prompt : prompt + suffix;
}

export function armDisallowedTools(arm: Arm): string | undefined {
  const builtin = builtinArmDefinition(arm);
  if (builtin !== undefined) return builtin.disallowedTools;
  const denied = customArmDefinition(arm).deniedTools;
  // undefined, not "", when there is nothing to deny — an empty --disallowedTools
  // value is a flag the CLI never needed to see (see runClaude.ts's
  // disallowedTools doc comment on how it is spliced into argv).
  return denied === undefined || denied.length === 0 ? undefined : denied.join(",");
}
