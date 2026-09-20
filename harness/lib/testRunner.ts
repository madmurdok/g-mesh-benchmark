import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { copyFixtureFiles } from "./fixtureFiles.js";
import { LANGUAGE_EXTENSIONS } from "./language.js";
import type { CorpusLanguage, Oracle } from "./types.js";

/**
 * How long `oracle.testCommand` may run before it's killed and the run graded
 * as a failure. Generous compared to the ~3s the actual test files take,
 * because the command also has to install the corpus's dependencies into the
 * throwaway clone first (`resolveFresh()` clones tracked files only — no
 * node_modules), which is the slow part and varies with npm cache state.
 *
 * A timeout is graded as a fail rather than an error on purpose: an agent that
 * leaves the corpus in a state where the suite hangs has not fixed the bug.
 */
const TEST_TIMEOUT_MS = 300_000;

/**
 * How much of the combined stdout+stderr is kept as the run record's reason.
 * The tail, not the head: a test runner's failure summary is the last thing it
 * prints, while the head is install chatter. Bounded so one failing run can't
 * bloat the results JSON by megabytes.
 */
const REASON_TAIL_CHARS = 2000;

export interface AcceptanceTestResult {
  passed: boolean;
  /** Tail of the command's combined output — enough to diagnose a failure from the run record alone. */
  reason: string;
}

const execFileAsync = promisify(execFile);

/**
 * Extensions a `testCommand` token has to end in before it counts as naming a
 * source file rather than a flag or a package name, for a corpus declared as
 * `language`. Deliberately a closed list: `--no-audit` and `vitest` must not
 * be mistaken for paths, and a token that is genuinely a path but wears an
 * extension not listed here is left alone rather than handed to `git
 * checkout` on a guess.
 *
 * Built from lib/language.ts's `LANGUAGE_EXTENSIONS` (GMB-164) rather than a
 * second hardcoded TS/JS-shaped list, plus `.mjs`/`.cjs` for ts/js only: those
 * mark a module-system variant of a JS/TS file (e.g. `vitest.config.mjs`) that
 * a `testCommand` can genuinely name even though cold-start.ts's
 * indexable-file walk deliberately excludes them (it counts source LOC, not
 * build/config wrappers) — the one place this list still needs its own
 * narrow addition on top of the shared base.
 */
function testFileExtensionsFor(language: CorpusLanguage): readonly string[] {
  return language === "ts" || language === "js"
    ? [...LANGUAGE_EXTENSIONS[language], ".mjs", ".cjs"]
    : LANGUAGE_EXTENSIONS[language];
}

/**
 * The paths a `testCommand` names that the agent could have edited.
 *
 * A token counts when it carries a `/` (so a bare `vitest` never does), ends
 * in one of [`testFileExtensionsFor`]'s extensions for `language`, and is not
 * one of `holdoutFiles`' own destinations. Quotes are stripped; nothing else
 * is interpreted, because the command is a shell line from this repo's
 * versioned tasks.json rather than anything a model produced, and the parse
 * only has to be right about strings we wrote.
 *
 * Everything about this is deliberately conservative. A path this misses stays
 * gradeable exactly as it is today; a path it wrongly *included* would revert
 * an agent edit that should have counted, so the failure mode is chosen to be
 * "changed nothing" rather than "silently discarded the agent's work".
 *
 * `language` defaults to "ts" — every existing caller (this repo's two
 * registered corpora, and every test below that predates GMB-164) is a TS
 * corpus and keeps its exact prior behavior without having to name it.
 */
export function regressionPathsIn(
  testCommand: string,
  holdoutDestinations: readonly string[],
  language: CorpusLanguage = "ts",
): string[] {
  const extensions = testFileExtensionsFor(language);
  const holdouts = new Set(holdoutDestinations.map((d) => d.replace(/^\.\//, "")));
  const seen = new Set<string>();
  for (const raw of testCommand.split(/\s+/)) {
    const token = raw.replace(/^["']|["']$/g, "").replace(/^\.\//, "");
    if (!token.includes("/")) continue;
    if (!extensions.some((ext) => token.endsWith(ext))) continue;
    if (holdouts.has(token)) continue;
    seen.add(token);
  }
  return [...seen];
}

/**
 * Puts the regression half of a test-mode oracle back the way the corpus
 * shipped it, so the oracle grades the agent's *implementation* and not the
 * tests the agent wrote about it.
 *
 * WHY THIS EXISTS
 *
 * `tt-implement-release-cancelled-task-bug` runs `tests/lifecycle.test.ts`
 * and two siblings alongside its one holdout, and those are ordinary tracked
 * files in the clone the agent has Edit/Write on. In the 2026-08-26
 * five-repetition sweep, all three of that task's oracle failures - one in
 * each arm - were an `it(...)` the agent had added to `tests/lifecycle.test.ts`
 * itself, under a different invented name in every run, each failing on the
 * same setup bug in the agent's own test rather than on anything it had
 * implemented. The task was the corpus's most-cited unstable one across three
 * separate findings notes; this was why (see
 * docs/results/v0.22.0-gmb152-the-per-task-anomaly-sweep.md).
 *
 * WHAT IT DOES NOT DO
 *
 * Only tracked paths the command names are restored, and only from `HEAD` of
 * the clone `corpusResolver` made. Holdout files are excluded by name and are
 * untracked anyway, so `checkout HEAD --` could not touch them. Everything
 * outside those paths - the agent's actual edits - is left exactly as found.
 *
 * THE TRADE-OFF, STATED
 *
 * This stops an agent being rewarded for writing good extra tests as well as
 * punished for writing bad ones. That is the intent: the holdout is the
 * grader, and a task whose acceptance genuinely depends on the agent editing a
 * tracked test file would need to say so rather than rely on this not
 * happening.
 *
 * A failure to restore is reported, never thrown: grading a run is worth more
 * than aborting a sweep over a git invocation, and a caller that knows one
 * path could not be restored can discount that record.
 */
async function restoreRegressionFiles(cwd: string, paths: readonly string[]): Promise<string | undefined> {
  if (paths.length === 0) return undefined;
  try {
    await execFileAsync("git", ["-C", cwd, "checkout", "HEAD", "--", ...paths]);
    return undefined;
  } catch (err) {
    return `could not restore ${paths.join(", ")} from HEAD before grading: ${String(err)}`;
  }
}

/**
 * The subset of `seedFiles` whose destination is itself one of the paths
 * `testCommand` names (by the same path-shaped-token rule `regressionPathsIn`
 * uses, via an unfiltered call to it).
 *
 * Exists for a seed that plays the *test's* fixture rather than the agent's
 * source — e.g. a diagnostics task whose testCommand runs a checker directly
 * against the seeded file. Excluding seed destinations from
 * `restoreRegressionFiles`'s list (below) already stops them being reverted to
 * HEAD; this is the belt to that suspenders, so such a file ends grading setup
 * in its seeded state even if something else along the way touched it —
 * without touching any seed the command doesn't name, which stays exactly as
 * the agent left it.
 */
function seedFilesNamedInCommand(
  testCommand: string,
  seedFiles: Record<string, string> | undefined,
  language: CorpusLanguage,
): Record<string, string> {
  if (!seedFiles) return {};
  const namedPaths = new Set(regressionPathsIn(testCommand, [], language));
  const named: Record<string, string> = {};
  for (const [dest, src] of Object.entries(seedFiles)) {
    if (namedPaths.has(dest.replace(/^\.\//, ""))) named[dest] = src;
  }
  return named;
}

/**
 * Grades a `mode: "test"` task: copies the oracle's held-out acceptance files
 * into the (throwaway, already-agent-edited) `cwd`, then runs the corpus's own
 * test command there and reports whether it exited 0.
 *
 * Kept out of lib/oracleCheck.ts deliberately. Every mode there grades the
 * agent's *answer text* and returns a `missed` list plus an optional judge
 * cost; this grades the agent's *edits*, ignores resultText entirely, spends
 * no API money, and needs a cwd that checkOracle has no reason to know about.
 * Sharing a signature would mean four of the six fields being dead on one side
 * or the other.
 *
 * The holdout copy happens here rather than before the agent's turn so the
 * acceptance criteria are genuinely held out: the agent has Edit/Write on this
 * clone and would otherwise be able to read the assertions it's being graded
 * against, or rewrite them.
 *
 * `seedFiles` is the task's own `BenchTask.seedFiles` (already copied into
 * `cwd` before the agent's turn by token-economy.ts's resolveRunCwd) — passed
 * through here only so grading can protect it, never to copy it in for the
 * first time.
 *
 * `language` is the corpus's own declared `CorpusEntry.language` (GMB-164),
 * threaded down from token-economy.ts's runArm()/gradeRun() so
 * `regressionPathsIn` recognizes the right extensions for this corpus rather
 * than a TS/JS-shaped guess. Defaults to "ts" so every pre-GMB-164 caller
 * (this repo's two registered corpora, and every test below) keeps its exact
 * prior behavior without having to name it.
 */
export async function runAcceptanceTest(
  cwd: string,
  oracle: Oracle,
  seedFiles?: Record<string, string>,
  language: CorpusLanguage = "ts",
): Promise<AcceptanceTestResult> {
  const testCommand = oracle.testCommand;
  if (!testCommand) {
    return { passed: false, reason: 'test mode requires oracle.testCommand' };
  }

  return withAcceptanceLock(async () => {
    // Before the holdouts, not after: restoring a path the holdout copy also
    // writes would undo the copy. Excluding holdout *and seed* destinations
    // from the restore list already makes that impossible for both, and doing
    // it in this order means it stays impossible if either exclusion is ever
    // loosened. A seed destination is excluded for the same reason a holdout
    // one is: its content lives only in the fixture and on disk, never in
    // this clone's HEAD, so `git checkout HEAD` on it would not "restore" it,
    // it would erase it (or, for a seed that overwrote a tracked file, revert
    // it to the corpus's unseeded original).
    const restoreWarning = await restoreRegressionFiles(
      cwd,
      regressionPathsIn(
        testCommand,
        [...Object.keys(oracle.holdoutFiles ?? {}), ...Object.keys(seedFiles ?? {})],
        language,
      ),
    );

    // See seedFilesNamedInCommand's doc comment for why this re-copy exists
    // even though the exclusion above already keeps git away from these paths.
    await copyFixtureFiles(cwd, seedFilesNamedInCommand(testCommand, seedFiles, language));
    await copyFixtureFiles(cwd, oracle.holdoutFiles);

    const { exitCode, output } = await runCommand(testCommand, cwd);
    const reason = output.slice(-REASON_TAIL_CHARS);
    return {
      passed: exitCode === 0,
      // Prepended, not appended: `reason` is a *tail* of the output and gets
      // truncated from the front, so a warning added at the end would be the
      // first thing lost on exactly the noisy runs that need it.
      reason: restoreWarning ? `g-mesh-bench: ${restoreWarning}\n${reason}` : reason,
    };
  });
}

/**
 * Tail of the queue of acceptance runs; each new run chains onto it so at most
 * one is ever executing in this process.
 */
let acceptanceQueue: Promise<unknown> = Promise.resolve();

/**
 * Serializes acceptance runs process-wide, even when the arms that produced
 * them ran concurrently (token-economy.ts runs a task's arms in parallel).
 *
 * Two reasons, both about the *install* half of a `testCommand` rather than the
 * assertions:
 *
 * - Every shipped test command installs dependencies first (`yarn install`,
 *   `npm ci`). Those share one package-manager cache directory per user, and
 *   yarn v1 in particular takes no cross-process lock by default — concurrent
 *   installs are a documented way to corrupt that cache, which would fail runs
 *   for reasons that have nothing to do with the arm being measured.
 * - The test runners are themselves parallel (vitest spawns a worker per core).
 *   Three of them at once on an 8-core machine oversubscribes it badly enough
 *   that a suite can cross TEST_TIMEOUT_MS and be graded as a failure — i.e.
 *   concurrency would change the recorded verdict, which is the one thing a
 *   speedup must never do.
 *
 * The cost is bounded and known: grading is ~10-15% of a sweep's wall-clock
 * (see task #118's phase profile), and only `mode: "test"` tasks reach here at
 * all. The agent calls — the part that actually dominates — still overlap.
 */
async function withAcceptanceLock<T>(fn: () => Promise<T>): Promise<T> {
  const prior = acceptanceQueue;
  let release!: () => void;
  acceptanceQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  // `.catch` so one failed acceptance run doesn't poison every later one's
  // wait: the queue exists to order them, not to propagate their outcomes.
  await prior.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * `shell: true` because testCommand is authored as a shell line (`npm ci && npx
 * vitest run ...`), not an argv array — the corpus, not this harness, decides
 * what "run the tests" means. Safe here: the command comes from this repo's own
 * versioned tasks.json, never from model output.
 *
 * stdout and stderr are interleaved into one buffer rather than kept apart,
 * since a test runner splits its report across both and only the combined
 * transcript reads correctly.
 */
function runCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TEST_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    // A spawn failure (command not found, cwd gone) is a fail, not a crash:
    // one un-runnable arm must not abort a benchmark that has already spent
    // real money on the runs before it.
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, output: `${output}\nfailed to spawn test command: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const suffix = timedOut ? `\ntest command timed out after ${TEST_TIMEOUT_MS}ms and was killed` : "";
      resolve({ exitCode: timedOut ? 1 : (code ?? 1), output: output + suffix });
    });
  });
}
