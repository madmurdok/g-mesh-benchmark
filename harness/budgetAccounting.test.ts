import assert from "node:assert/strict";
import test from "node:test";
import { combinedBudgetStatus, MAX_COMBINED_BUDGET_USD } from "./token-economy.js";

/**
 * Covers the arm+judge combined budget bound without spending API money: the
 * decision is a pure function of (arm status, arm cost, judge cost), so the
 * budget_exceeded path is exercised with simulated costs.
 *
 * Run: npx tsx harness/budgetAccounting.test.ts
 * (no test runner is wired into package.json in this repo).
 *
 * Ceiling under test = MAX_COMBINED_BUDGET_USD, imported rather than
 * hardcoded so a future change to MAX_BUDGET_USD/JUDGE_MAX_BUDGET_USD (e.g.
 * raising the former to let a slower task finish grading) doesn't silently
 * desync these tests from the real constant.
 */

test("a substring-mode run (no judge spend) stays ok", () => {
  assert.equal(combinedBudgetStatus("ok", 0.42, 0), "ok");
});

test("a judge-mode run under the combined ceiling stays ok", () => {
  assert.equal(combinedBudgetStatus("ok", 0.42, 0.03), "ok");
});

test("a run landing exactly on the combined ceiling is still within budget", () => {
  assert.equal(combinedBudgetStatus("ok", MAX_COMBINED_BUDGET_USD, 0), "ok");
});

test("a successful arm call is marked budget_exceeded when judge spend pushes the pair over the ceiling", () => {
  // The arm call itself succeeded and was under its own MAX_BUDGET_USD cap;
  // only arm + judge together cross the ceiling. This is the case that was
  // silently unaccounted for before.
  assert.equal(combinedBudgetStatus("ok", MAX_COMBINED_BUDGET_USD, 0.01), "budget_exceeded");
});

test("arm spend alone can trip the combined ceiling", () => {
  assert.equal(combinedBudgetStatus("ok", MAX_COMBINED_BUDGET_USD + 0.2, 0), "budget_exceeded");
});

test("an already-failed arm run keeps its own status", () => {
  assert.equal(combinedBudgetStatus("error", 0.1, 0.02), "error");
  assert.equal(combinedBudgetStatus("budget_exceeded", 1.4, 0), "budget_exceeded");
});
