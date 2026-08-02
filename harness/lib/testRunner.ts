import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Oracle } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
 * The copy happens here rather than before the agent's turn so the acceptance
 * criteria are genuinely held out: the agent has Edit/Write on this clone and
 * would otherwise be able to read the assertions it's being graded against, or
 * rewrite them.
 */
export async function runAcceptanceTest(cwd: string, oracle: Oracle): Promise<AcceptanceTestResult> {
  if (!oracle.testCommand) {
    return { passed: false, reason: 'test mode requires oracle.testCommand' };
  }

  for (const [dest, src] of Object.entries(oracle.holdoutFiles ?? {})) {
    const contents = await readFile(path.join(ROOT, src), "utf-8");
    const destPath = path.join(cwd, dest);
    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, contents);
  }

  const { exitCode, output } = await runCommand(oracle.testCommand, cwd);
  return { passed: exitCode === 0, reason: output.slice(-REASON_TAIL_CHARS) };
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
