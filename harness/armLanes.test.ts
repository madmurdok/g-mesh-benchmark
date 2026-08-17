import assert from "node:assert/strict";
import test from "node:test";
import { armConcurrencyLimit, groupArmsByCwd } from "./token-economy.js";
import type { Arm } from "./lib/types.js";

/**
 * Covers which arms of a (task, repetition) are allowed to overlap. Pure
 * functions, so no clone, no install, no API spend.
 *
 * Run: npx tsx harness/armLanes.test.ts
 * (no test runner is wired into package.json in this repo).
 */

const arms = (...names: string[]) => names as Arm[];

test("arms with distinct cwds each get their own lane", () => {
  const lanes = groupArmsByCwd(arms("gmesh-configured", "serena-configured", "baseline"), ["/a", "/b", "/c"]);
  assert.deepEqual(lanes, [[0], [1], [2]]);
});

test("arms sharing a checkout share a lane and stay in arm order", () => {
  // The real case: bare gmesh, gmesh-trusted and baseline all run from the
  // shared warm checkout — and gmesh/gmesh-trusted also share a prompt-cache
  // prefix, which is why they must not overlap.
  const lanes = groupArmsByCwd(arms("gmesh-configured", "gmesh", "gmesh-trusted", "baseline"), [
    "/configured",
    "/warm",
    "/warm",
    "/warm",
  ]);
  assert.deepEqual(lanes, [[0], [1, 2, 3]]);
});

test("lane order follows first appearance", () => {
  const lanes = groupArmsByCwd(arms("a", "b", "c"), ["/warm", "/own", "/warm"]);
  assert.deepEqual(lanes, [[0, 2], [1]]);
});

test("every arm lands in exactly one lane", () => {
  const cwds = ["/x", "/y", "/x", "/z", "/y"];
  const lanes = groupArmsByCwd(arms("a", "b", "c", "d", "e"), cwds);
  assert.deepEqual(lanes.flat().sort((p, q) => p - q), [0, 1, 2, 3, 4]);
});

test("arm concurrency defaults to the arm count and is overridable", () => {
  delete process.env.G_MESH_BENCH_ARM_CONCURRENCY;
  assert.equal(armConcurrencyLimit(3), 3);
  process.env.G_MESH_BENCH_ARM_CONCURRENCY = "1";
  assert.equal(armConcurrencyLimit(3), 1);
  process.env.G_MESH_BENCH_ARM_CONCURRENCY = "0";
  assert.throws(() => armConcurrencyLimit(3), /expected a positive integer/);
  process.env.G_MESH_BENCH_ARM_CONCURRENCY = "two";
  assert.throws(() => armConcurrencyLimit(3), /expected a positive integer/);
  delete process.env.G_MESH_BENCH_ARM_CONCURRENCY;
});
