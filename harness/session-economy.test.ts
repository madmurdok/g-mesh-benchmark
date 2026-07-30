import assert from "node:assert/strict";
import test from "node:test";
import { sessionBudgetCeiling, sessionBudgetStatus } from "./session-economy.js";

/**
 * Covers the chained-session budget bound without spending API money: the
 * decision is a pure function of (cumulative chain spend, ceiling), so the
 * chain-abort path is exercised with simulated costs.
 *
 * Run: npx tsx harness/session-economy.test.ts
 * (no test runner is wired into package.json in this repo).
 *
 * Importing this module does not start a benchmark — session-economy.ts only
 * calls main() when it is the process entry point.
 */

test("the ceiling is the per-call ceiling times the number of calls a chain will make", () => {
  assert.equal(sessionBudgetCeiling(5, 1.05), 5.25);
});

test("the ceiling scales with task count, so a longer chain is allowed proportionally more", () => {
  const short = sessionBudgetCeiling(5, 1.05);
  const long = sessionBudgetCeiling(15, 1.05);
  assert.equal(long, short * 3);
  assert.ok(long > short);
});

test("an empty chain gets a zero ceiling rather than an unbounded one", () => {
  assert.equal(sessionBudgetCeiling(0, 1.05), 0);
});

test("a chain under its ceiling keeps running", () => {
  assert.equal(sessionBudgetStatus(1.2, 5.25), "ok");
});

test("a chain landing exactly on its ceiling is still within budget", () => {
  // Strict >, matching combinedBudgetStatus's boundary convention.
  assert.equal(sessionBudgetStatus(5.25, 5.25), "ok");
});

test("a chain over its ceiling is exceeded", () => {
  assert.equal(sessionBudgetStatus(5.2501, 5.25), "exceeded");
});

test("a chain that spent nothing yet is ok even against a zero ceiling", () => {
  assert.equal(sessionBudgetStatus(0, 0), "ok");
});
