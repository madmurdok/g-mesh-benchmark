/**
 * Runs `fn` over `items` with at most `limit` in flight, resolving to the
 * results **in input order** regardless of completion order.
 *
 * Input order is the contract, not an implementation detail: the caller
 * (token-economy.ts's arm group) appends these straight into the run records
 * array, and a results file whose rows are ordered by whichever arm happened to
 * finish first would make every diff against a previous run unreadable — and
 * would silently reorder the "first arm of the group" that a reader of the raw
 * JSON assumes is `arms[0]`.
 *
 * Rejection semantics deliberately match `Promise.all`: the first failure
 * rejects, and work already in flight is left to settle on its own. The harness
 * treats a dead arm as a whole-run abort (see lib/mcpHealth.ts's
 * exitOnDeadArm), so "fail fast, don't start anything new" is exactly the
 * wanted behaviour — an aggregating variant would keep spending money after the
 * run is already invalid.
 *
 * `limit` is clamped to at least 1, so a mis-set concurrency of 0 degrades to
 * fully serial execution rather than deadlocking on an empty worker pool.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effectiveLimit = Math.max(1, Math.floor(limit));
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }

  const workers = Array.from({ length: Math.min(effectiveLimit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
