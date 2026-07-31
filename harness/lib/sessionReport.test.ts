import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEconomyRun } from "../session-economy.js";
import { computeSequenceTokenTable } from "./sessionReport.js";
import type { Arm } from "./types.js";

/**
 * Covers the per-position aggregation without spending API money — it is a
 * pure function of a run set, so the grouping rules that make the numbers
 * mean what the report says they mean are exercised with fixtures.
 *
 * Run: npx tsx harness/lib/sessionReport.test.ts
 * (no test runner is wired into package.json in this repo).
 */

let seq = 0;

function run(overrides: {
  corpusId: string;
  arm: Arm;
  sequenceIndex: number;
  sessionLength: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  status?: SessionEconomyRun["status"];
  repetition?: number;
}): SessionEconomyRun {
  return {
    taskId: `task-${seq++}`,
    corpusId: overrides.corpusId,
    arm: overrides.arm,
    repetition: overrides.repetition ?? 1,
    timestamp: "2026-07-31T00:00:00.000Z",
    model: "claude-sonnet-5",
    taskDefHash: "hash",
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    numTurns: 1,
    durationMs: 1,
    costUsd: 0,
    judgeCostUsd: 0,
    resultText: "",
    oraclePassed: true,
    status: overrides.status ?? "ok",
    sequenceIndex: overrides.sequenceIndex,
    sessionLength: overrides.sessionLength,
  };
}

test("averages every ok run at one (corpus, arm, position) cell", () => {
  const rows = computeSequenceTokenTable([
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 1, sessionLength: 2, inputTokens: 100, cacheCreationTokens: 20000, repetition: 1 }),
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 1, sessionLength: 2, inputTokens: 300, cacheCreationTokens: 10000, repetition: 2 }),
  ]);

  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.n, 2);
  // tokensSpent = input + output + cacheRead + cacheCreation.
  assert.equal(row.meanTotalTokens, (20100 + 10300) / 2);
  assert.equal(row.meanCacheCreationTokens, 15000);
});

test("cache-read (and input/output) are broken out per position alongside cache-creation — this experiment's actual finding", () => {
  const rows = computeSequenceTokenTable([
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 1, sessionLength: 3, inputTokens: 6, outputTokens: 700, cacheCreationTokens: 5000, cacheReadTokens: 10000, repetition: 1 }),
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 3, sessionLength: 3, inputTokens: 8, outputTokens: 900, cacheCreationTokens: 5200, cacheReadTokens: 90000, repetition: 1 }),
  ]);

  const first = rows.find((r) => r.sequenceIndex === 1)!;
  const third = rows.find((r) => r.sequenceIndex === 3)!;
  // Cache-creation stays roughly flat across positions (same MCP tool-schema
  // tax paid once per call); cache-read grows because the transcript being
  // re-read gets longer — the two fields must diverge, not track together.
  assert.equal(first.meanCacheCreationTokens, 5000);
  assert.equal(third.meanCacheCreationTokens, 5200);
  assert.equal(first.meanCacheReadTokens, 10000);
  assert.equal(third.meanCacheReadTokens, 90000);
  assert.equal(first.meanInputTokens, 6);
  assert.equal(first.meanOutputTokens, 700);
});

test("two corpora of different chain lengths never pool into the same row", () => {
  const rows = computeSequenceTokenTable([
    run({ corpusId: "short", arm: "gmesh", sequenceIndex: 1, sessionLength: 2, cacheCreationTokens: 1000 }),
    run({ corpusId: "long", arm: "gmesh", sequenceIndex: 1, sessionLength: 5, cacheCreationTokens: 9000 }),
  ]);

  assert.equal(rows.length, 2);
  const short = rows.find((r) => r.corpusId === "short")!;
  const long = rows.find((r) => r.corpusId === "long")!;
  assert.equal(short.n, 1);
  assert.equal(long.n, 1);
  assert.equal(short.meanCacheCreationTokens, 1000);
  assert.equal(long.meanCacheCreationTokens, 9000);
});

test("positions past a shorter corpus's chain length are absent, not zero-filled or borrowed", () => {
  const rows = computeSequenceTokenTable([
    run({ corpusId: "short", arm: "gmesh", sequenceIndex: 1, sessionLength: 2, cacheCreationTokens: 1000 }),
    run({ corpusId: "short", arm: "gmesh", sequenceIndex: 2, sessionLength: 2, cacheCreationTokens: 100 }),
    run({ corpusId: "long", arm: "gmesh", sequenceIndex: 1, sessionLength: 4, cacheCreationTokens: 9000 }),
    run({ corpusId: "long", arm: "gmesh", sequenceIndex: 2, sessionLength: 4, cacheCreationTokens: 900 }),
    run({ corpusId: "long", arm: "gmesh", sequenceIndex: 3, sessionLength: 4, cacheCreationTokens: 800 }),
    run({ corpusId: "long", arm: "gmesh", sequenceIndex: 4, sessionLength: 4, cacheCreationTokens: 700 }),
  ]);

  const shortPositions = rows.filter((r) => r.corpusId === "short").map((r) => r.sequenceIndex);
  assert.deepEqual(shortPositions, [1, 2]);
  const longPositions = rows.filter((r) => r.corpusId === "long").map((r) => r.sequenceIndex);
  assert.deepEqual(longPositions, [1, 2, 3, 4]);
  // Nothing at short's position 3+: the shorter corpus simply has no data
  // there, and must never inherit the longer corpus's.
  assert.equal(rows.some((r) => r.corpusId === "short" && r.sequenceIndex > 2), false);
});

test("skipped and error runs never contribute to a cell's mean", () => {
  const rows = computeSequenceTokenTable([
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 1, sessionLength: 3, cacheCreationTokens: 20000 }),
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 1, sessionLength: 3, cacheCreationTokens: 0, status: "skipped", repetition: 2 }),
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 1, sessionLength: 3, cacheCreationTokens: 0, status: "error", repetition: 3 }),
  ]);

  assert.equal(rows.length, 1);
  // A skipped/errored run is a missing measurement, not a free successful one:
  // counting either would halve (or third) this cell's mean.
  assert.equal(rows[0]!.n, 1);
  assert.equal(rows[0]!.meanCacheCreationTokens, 20000);
});

test("a position with only skipped runs is omitted entirely rather than emitted with n=0", () => {
  const rows = computeSequenceTokenTable([
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 1, sessionLength: 2, cacheCreationTokens: 20000 }),
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 2, sessionLength: 2, status: "skipped" }),
  ]);

  assert.deepEqual(rows.map((r) => r.sequenceIndex), [1]);
});

test("rows are grouped per arm and sorted by corpus, then arm order, then position", () => {
  const rows = computeSequenceTokenTable([
    run({ corpusId: "c", arm: "baseline", sequenceIndex: 2, sessionLength: 2, cacheCreationTokens: 5 }),
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 2, sessionLength: 2, cacheCreationTokens: 7 }),
    run({ corpusId: "c", arm: "baseline", sequenceIndex: 1, sessionLength: 2, cacheCreationTokens: 6 }),
    run({ corpusId: "c", arm: "gmesh", sequenceIndex: 1, sessionLength: 2, cacheCreationTokens: 8 }),
  ]);

  assert.deepEqual(
    rows.map((r) => `${r.arm}:${r.sequenceIndex}`),
    ["gmesh:1", "gmesh:2", "baseline:1", "baseline:2"],
  );
});
