import assert from "node:assert/strict";
import test from "node:test";
import { mapWithConcurrency } from "./concurrency.js";

test("results come back in input order, not completion order", async () => {
  const delays = [30, 5, 20, 0];
  const out = await mapWithConcurrency(delays, 4, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3]);
});

test("never exceeds the concurrency limit", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return null;
  });
  assert.equal(peak, 3);
});

test("limit 1 is fully serial", async () => {
  const order: number[] = [];
  await mapWithConcurrency([20, 10, 0], 1, async (ms, i) => {
    await new Promise((r) => setTimeout(r, ms));
    order.push(i);
    return null;
  });
  assert.deepEqual(order, [0, 1, 2]);
});

test("a limit below 1 degrades to serial rather than hanging", async () => {
  const out = await mapWithConcurrency([1, 2], 0, async (n) => n * 2);
  assert.deepEqual(out, [2, 4]);
});

test("the first rejection propagates", async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    }),
    /boom/,
  );
});

test("an empty input list resolves to an empty array without spawning workers", async () => {
  let calls = 0;
  const out = await mapWithConcurrency([], 4, async () => {
    calls += 1;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});
