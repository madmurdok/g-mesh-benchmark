/**
 * Wall-clock accounting for a benchmark run, broken down by phase.
 *
 * Exists because "the sweep takes four hours" was, until task #118, the only
 * number anyone had: the run records carry each arm call's own `durationMs`,
 * but everything *around* those calls — cloning corpora, cold g-mesh index
 * walks, `yarn install` inside a test-mode sandbox, judge calls, the CLI's own
 * process/MCP startup before the model gets the prompt — was invisible, so
 * every proposal to speed the harness up was a guess about which of those
 * mattered.
 *
 * Deliberately a process-global tally rather than something threaded through
 * every call site: the phases being measured are spread across four modules
 * (corpusResolver, runClaude, testRunner/judge via token-economy, the report
 * tail) and the only consumer is one summary printed at the end of `main()`.
 * Threading a timer object through resolveConfigured() → resolveFresh() →
 * cloneCorpus() to reach the one place that knows how long a clone took would
 * change every signature in between for no gain.
 *
 * Cost when idle is a `performance.now()` pair and a map lookup per phase, so
 * it is always on — a profile you have to remember to enable is a profile you
 * do not have when the slow run happens.
 */

/**
 * The phases a run's wall-clock is split into. A closed union rather than free
 * strings so a typo can't silently open a fourteenth bucket that never lines up
 * with the thirteen everyone reads.
 */
export type Phase =
  /** `git clone` + `git checkout` of a corpus into a fresh sandbox or the warm cache. */
  | "corpus.clone"
  /** Bringing an existing warm-cache checkout onto this run's pinned revision (fetch + hard checkout). */
  | "corpus.refresh"
  /** Restoring a reused sandbox to a pristine tree between repetitions (checkout --force + clean). */
  | "corpus.reset"
  /** `g-mesh init` — the bulk index walk, cold on a brand-new checkout and a no-op on a reused one. */
  | "gmesh.index"
  /** `g-mesh map --write` for the gmesh-configured-map arm. */
  | "gmesh.map"
  /** A measured arm call: the whole `claude -p` process, spawn to exit. */
  | "agent.call"
  /** What the CLI itself reported as that call's `duration_ms` — a subset of agent.call, not an addition to it. */
  | "agent.cli"
  /** A cache warm-up call (one per arm prefix, before the loop). */
  | "warmup"
  /** `mode: "test"` grading: dependency install plus the corpus's own test command. */
  | "grade.test"
  /** `mode: "judge"` grading: the extra `claude -p` call. */
  | "grade.judge"
  /** The optional narrative `claude -p` call for the HTML report. */
  | "report.narrative"
  /** Rendering and writing the JSON/HTML artifacts. */
  | "report.render";

interface PhaseTally {
  totalMs: number;
  count: number;
  maxMs: number;
}

const tallies = new Map<Phase, PhaseTally>();

/** Records `ms` against `phase`. Exported for the one caller that has a duration but never held the clock (runClaude's `agent.cli`, which comes off the CLI's own result event). */
export function recordPhase(phase: Phase, ms: number): void {
  const tally = tallies.get(phase) ?? { totalMs: 0, count: 0, maxMs: 0 };
  tally.totalMs += ms;
  tally.count += 1;
  tally.maxMs = Math.max(tally.maxMs, ms);
  tallies.set(phase, tally);
}

/**
 * Times `fn` into `phase` and returns its result.
 *
 * The timing is in a `finally`, so a phase that throws is still counted — a
 * clone that failed after 90 seconds spent those 90 seconds, and a profile that
 * silently dropped them would understate exactly the phase worth looking at.
 */
export async function timePhase<T>(phase: Phase, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await fn();
  } finally {
    recordPhase(phase, performance.now() - start);
  }
}

export interface PhaseRow {
  phase: Phase;
  totalMs: number;
  count: number;
  meanMs: number;
  maxMs: number;
}

/** Every phase that recorded at least one sample, heaviest first. */
export function phaseRows(): PhaseRow[] {
  return [...tallies.entries()]
    .map(([phase, t]) => ({ phase, totalMs: t.totalMs, count: t.count, meanMs: t.totalMs / t.count, maxMs: t.maxMs }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

/** Drops every tally. Tests only — the tally is process-global on purpose (see this module's doc comment). */
export function resetPhases(): void {
  tallies.clear();
}

/**
 * Phases whose time is already counted inside another phase, and so must be
 * left out of any "how much of the wall-clock is accounted for" sum.
 *
 * `agent.cli` is the CLI's own view of a call that `agent.call` already timed
 * end to end; it is kept as its own row precisely because the *difference*
 * between the two is the interesting number (process startup, MCP server boot,
 * settings discovery — everything before the model sees the prompt).
 */
const DERIVED_PHASES: ReadonlySet<Phase> = new Set<Phase>(["agent.cli"]);

/**
 * The profile, as text.
 *
 * `wallMs` is the run's real elapsed time, so the summary can say what fraction
 * the phases account for. Under concurrency the phase total can legitimately
 * exceed the wall-clock (two arms billed the same seconds), which is reported
 * as an over-100% share rather than hidden — that ratio is itself the answer to
 * "did the parallelism actually overlap anything".
 */
export function formatPhaseSummary(wallMs: number): string {
  const rows = phaseRows();
  if (rows.length === 0) return "No phases recorded.";
  const accounted = rows.filter((r) => !DERIVED_PHASES.has(r.phase)).reduce((sum, r) => sum + r.totalMs, 0);
  const lines = [
    "",
    "Phase profile (wall-clock accounting)",
    `  run wall-clock: ${fmtDuration(wallMs)}`,
    "",
    `  ${"phase".padEnd(18)}${"total".padStart(10)}${"share".padStart(8)}${"n".padStart(6)}${"mean".padStart(10)}${"max".padStart(10)}`,
  ];
  for (const r of rows) {
    const share = DERIVED_PHASES.has(r.phase) ? "(incl.)" : `${((100 * r.totalMs) / wallMs).toFixed(1)}%`;
    lines.push(
      `  ${r.phase.padEnd(18)}${fmtDuration(r.totalMs).padStart(10)}${share.padStart(8)}${String(r.count).padStart(6)}` +
        `${fmtDuration(r.meanMs).padStart(10)}${fmtDuration(r.maxMs).padStart(10)}`,
    );
  }
  const agentCall = tallies.get("agent.call");
  const agentCli = tallies.get("agent.cli");
  if (agentCall && agentCli) {
    const overheadMs = agentCall.totalMs - agentCli.totalMs;
    lines.push(
      "",
      `  claude -p startup overhead (agent.call - agent.cli): ${fmtDuration(overheadMs)} over ${agentCall.count} calls ` +
        `(${(overheadMs / agentCall.count / 1000).toFixed(1)}s each)`,
    );
  }
  lines.push(
    "",
    `  accounted: ${fmtDuration(accounted)} of ${fmtDuration(wallMs)} (${((100 * accounted) / wallMs).toFixed(1)}%)`,
    "",
  );
  return lines.join("\n");
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = (ms % 60_000) / 1000;
  return `${minutes}m${seconds.toFixed(0).padStart(2, "0")}s`;
}

/** The machine-readable half of the same profile, written next to the run's own results. */
export function phaseProfileJson(wallMs: number): object {
  return {
    wallMs,
    phases: phaseRows(),
  };
}
