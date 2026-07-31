import assert from "node:assert/strict";
import test from "node:test";
import { checkOracle } from "./oracleCheck.js";
import type { Oracle } from "./types.js";

/**
 * Covers checkOracle's substring and pool modes without spending API money —
 * judge mode makes a real `claude -p` call and is out of scope here.
 *
 * Run: npx tsx harness/lib/oracleCheck.test.ts
 * (no test runner is wired into package.json in this repo — see
 * reportData.test.ts for the same convention.)
 */

function poolOracle(overrides: Partial<Oracle> = {}): Oracle {
  return {
    mode: "pool",
    candidatePool: ["src/domain/status.ts", "tests/tasks.test.ts"],
    minMatches: 1,
    ...overrides,
  };
}

test("pool mode passes when a candidate is affirmatively mentioned", async () => {
  const result = await checkOracle(
    "The callers are src/domain/status.ts and nowhere else.",
    poolOracle(),
  );
  assert.equal(result.passed, true);
});

test("pool mode fails when the only mention of a candidate explicitly denies it (real gmesh-trusted failure, transcript 610bd3a2)", async () => {
  const resultText =
    "Все вызовы находятся в том же файле, где функция определена. " +
    "В `src/domain/status.ts` и `src/domain/releases.ts` встречается похожее имя, " +
    "но это другой, одноимённый хелпер, а не вызовы этой функции.";
  const result = await checkOracle(resultText, poolOracle());
  assert.equal(result.passed, false);
  assert.deepEqual(result.missed, ["src/domain/status.ts", "tests/tasks.test.ts"]);
});

test("pool mode fails an English denial of the only mentioned candidate", async () => {
  const resultText =
    "I checked every call site and none of them are in src/domain/status.ts " +
    "or tests/tasks.test.ts — that file isn't a caller, it just has a similarly named helper.";
  const result = await checkOracle(resultText, poolOracle());
  assert.equal(result.passed, false);
});

test("pool mode's negation guard is local — an unrelated negation far away in the text doesn't retract a real, affirmed mention", () =>
  checkOracle(
    "requireTask is called from src/domain/status.ts, which is the primary lookup helper used " +
      "across the task lifecycle and dependency-check code paths throughout the domain layer. " +
      "Separately, there is releases.ts, which defines a similarly named helper used only " +
      "internally by the release workflow, and that is not this one.",
    poolOracle(),
  ).then((result) => {
    assert.equal(result.passed, true);
    assert.deepEqual(result.missed, ["tests/tasks.test.ts"]);
  }));

test("pool mode: an unrelated negation in a different bullet doesn't retract a candidate affirmed in its own bullet (real kungfu failure, tt-references-requiretask)", async () => {
  const resultText =
    "`requireTask` is defined at `src/domain/tasks.ts:78`. It's actually called (not just mentioned) from:\n\n" +
    '- `src/domain/tasks.ts` itself (internal calls at lines 100, 177, 211 — same file, not "other")\n' +
    "- `src/domain/status.ts:49` (inside `getTaskDetail`)\n" +
    "- `tests/tasks.test.ts` (lines 107, 142, 175, 180)\n\n" +
    "Note: `src/domain/releases.ts` defines a distinct, deliberately separate helper `requireTaskProjectAndRelease` " +
    "(its own comment explains it avoids importing `requireTask` to prevent a circular import) — it does **not** " +
    "call `requireTask`, so it's excluded.\n\n" +
    "So excluding the defining file, the callers are: **`src/domain/status.ts`** and **`tests/tasks.test.ts`**.";
  const result = await checkOracle(resultText, poolOracle());
  assert.equal(result.passed, true);
  assert.deepEqual(result.missed, []);
});

test("pool mode still fails a candidate that is never mentioned at all", async () => {
  const result = await checkOracle("No callers found anywhere in the repo.", poolOracle());
  assert.equal(result.passed, false);
  assert.deepEqual(result.missed, ["src/domain/status.ts", "tests/tasks.test.ts"]);
});

test("pool mode respects minMatches across multiple affirmed candidates", async () => {
  const oracle = poolOracle({
    candidatePool: ["a.ts", "b.ts", "c.ts"],
    minMatches: 2,
  });
  const onlyOneHit = await checkOracle("Called from a.ts.", oracle);
  assert.equal(onlyOneHit.passed, false);

  const twoHits = await checkOracle("Called from a.ts and b.ts.", oracle);
  assert.equal(twoHits.passed, true);
});

test("pool mode: 'excluding X, the callers are: Y' affirms Y even though 'excluding' precedes it on the same line (real kungfu failure, ex-multihop-mutateelement-sizehelper-transitive)", async () => {
  const oracle = poolOracle({
    candidatePool: [
      "getSizeFromPoints",
      "packages/element/src/elbowArrow.ts",
      "packages/element/src/transform.ts",
      "packages/excalidraw/data/restore.ts",
    ],
    minMatches: 4,
  });
  const resultText =
    "The helper is **`getSizeFromPoints`**, defined in `packages/common/src/points.ts`.\n\n" +
    "Excluding that definition file and `packages/element/src/mutateElement.ts`, the other callers are:\n\n" +
    "- `packages/element/src/transform.ts` — `convertToExcalidrawElements`\n" +
    "- `packages/element/src/elbowArrow.ts` — `normalizeArrowElementUpdate`\n" +
    "- `packages/excalidraw/data/restore.ts` — `restoreElement`\n" +
    "- `packages/element/tests/resize.test.tsx` — test usage";
  const result = await checkOracle(resultText, oracle);
  assert.equal(result.passed, true);
  assert.deepEqual(result.missed, []);
});

test("substring mode is untouched by the pool negation guard (v1 behavior preserved)", async () => {
  const oracle: Oracle = { mustMentionFiles: ["src/foo.ts"] };
  const result = await checkOracle("Not src/foo.ts, that's unrelated.", oracle);
  assert.equal(result.passed, true, "substring mode has no negation awareness by design");
});
