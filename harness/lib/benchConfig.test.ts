import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyArmIncludeOverrides, DEFAULT_CONFIG, loadBenchConfig, resetBenchConfigCache } from "./benchConfig.js";

/**
 * Covers loadBenchConfig()'s precedence/validation and
 * applyArmIncludeOverrides()'s idempotency. Every test that touches disk uses
 * a temp fixture file passed via the `configPath` param — never the repo's
 * own checked-in g-mesh-bench.config.json — and resets the module cache in
 * setup/teardown so tests don't leak state into each other (see
 * resetBenchConfigCache()'s doc comment).
 *
 * Run: npx tsx --test harness/lib/benchConfig.test.ts
 * (no test runner is wired into package.json in this repo — see
 * armConfig.test.ts for the same convention.)
 */

function withFixture(contents: string | undefined, fn: (configPath: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "gmesh-bench-config-"));
  const configPath = path.join(dir, "g-mesh-bench.config.json");
  try {
    if (contents !== undefined) writeFileSync(configPath, contents);
    resetBenchConfigCache();
    fn(configPath);
  } finally {
    resetBenchConfigCache();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a missing config file falls back to DEFAULT_CONFIG verbatim", () => {
  withFixture(undefined, (configPath) => {
    assert.deepEqual(loadBenchConfig(configPath), DEFAULT_CONFIG);
  });
});

test("malformed JSON throws, naming the file path", () => {
  withFixture("{ not valid json", (configPath) => {
    assert.throws(() => loadBenchConfig(configPath), (err: Error) => {
      assert.match(err.message, new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return true;
    });
  });
});

test("an unknown top-level key throws a path-qualified message", () => {
  withFixture(JSON.stringify({ notARealSection: {} }), (configPath) => {
    assert.throws(
      () => loadBenchConfig(configPath),
      /Invalid g-mesh-bench\.config\.json: notARealSection is not a recognized top-level field\./,
    );
  });
});

test("an unknown nested key throws a path-qualified message", () => {
  withFixture(JSON.stringify({ tokenEconomy: { notAField: true } }), (configPath) => {
    assert.throws(
      () => loadBenchConfig(configPath),
      /Invalid g-mesh-bench\.config\.json: tokenEconomy\.notAField is not a recognized field\./,
    );
  });
});

test("a wrong-typed field throws a path-qualified message", () => {
  withFixture(JSON.stringify({ report: { htmlNarrative: "yes" } }), (configPath) => {
    assert.throws(
      () => loadBenchConfig(configPath),
      /Invalid g-mesh-bench\.config\.json: report\.htmlNarrative must be a boolean \(got "yes"\)\./,
    );
  });
});

test("an unknown arm name throws a path-qualified message", () => {
  withFixture(JSON.stringify({ tokenEconomy: { arms: ["gmesh-configured", "not-a-real-arm"] } }), (configPath) => {
    assert.throws(
      () => loadBenchConfig(configPath),
      /Invalid g-mesh-bench\.config\.json: tokenEconomy\.arms\[1\] must be one of .* \(got "not-a-real-arm"\)\./,
    );
  });
});

test("an unrecognized preset string throws, matching the codebase's existing phrasing", () => {
  withFixture(JSON.stringify({ tokenEconomy: { repetitions: "fast" } }), (configPath) => {
    assert.throws(
      () => loadBenchConfig(configPath),
      /Invalid g-mesh-bench\.config\.json: tokenEconomy\.repetitions must be "low", "normal", or "max" \(got "fast"\)\./,
    );
  });
});

test("a non-positive samples value throws", () => {
  withFixture(JSON.stringify({ searchLatency: { samples: 0 } }), (configPath) => {
    assert.throws(
      () => loadBenchConfig(configPath),
      /Invalid g-mesh-bench\.config\.json: searchLatency\.samples must be a positive integer \(got 0\)\./,
    );
  });
});

test("a partial config deep-merges: untouched fields keep DEFAULT_CONFIG's values", () => {
  withFixture(JSON.stringify({ tokenEconomy: { arms: ["gmesh", "baseline"] } }), (configPath) => {
    const config = loadBenchConfig(configPath);
    assert.deepEqual(config.tokenEconomy.arms, ["gmesh", "baseline"]);
    assert.equal(config.tokenEconomy.repetitions, DEFAULT_CONFIG.tokenEconomy.repetitions);
    assert.equal(config.tokenEconomy.excalidrawScope, DEFAULT_CONFIG.tokenEconomy.excalidrawScope);
    assert.equal(config.tokenEconomy.htmlNarrative, DEFAULT_CONFIG.tokenEconomy.htmlNarrative);
    assert.equal(config.tokenEconomy.warmCache, DEFAULT_CONFIG.tokenEconomy.warmCache);
    assert.deepEqual(config.sessionEconomy, DEFAULT_CONFIG.sessionEconomy);
    assert.deepEqual(config.searchLatency, DEFAULT_CONFIG.searchLatency);
    assert.deepEqual(config.report, DEFAULT_CONFIG.report);
    assert.deepEqual(config.runClaude, DEFAULT_CONFIG.runClaude);
  });
});

test("a fully valid config round-trips unchanged", () => {
  const custom = {
    tokenEconomy: {
      arms: ["gmesh", "baseline"],
      repetitions: "low",
      excalidrawScope: "high",
      htmlNarrative: false,
      warmCache: true,
    },
    sessionEconomy: { arms: ["gmesh-trusted", "baseline"], repetitions: "max" },
    searchLatency: { samples: 5 },
    report: { htmlNarrative: false },
    runClaude: { saveTranscripts: true },
  };
  withFixture(JSON.stringify(custom), (configPath) => {
    assert.deepEqual(loadBenchConfig(configPath), custom);
  });
});

test("loadBenchConfig caches: a second call ignores a changed configPath argument", () => {
  withFixture(JSON.stringify({ searchLatency: { samples: 7 } }), (configPath) => {
    const first = loadBenchConfig(configPath);
    assert.equal(first.searchLatency.samples, 7);
    // A second call with a nonexistent path still returns the cached value,
    // not DEFAULT_CONFIG, proving the module-level cache is in effect.
    const second = loadBenchConfig(path.join(path.dirname(configPath), "does-not-exist.json"));
    assert.equal(second.searchLatency.samples, 7);
  });
});

test("applyArmIncludeOverrides appends only arms not already present, preserving order", () => {
  assert.deepEqual(
    applyArmIncludeOverrides(["gmesh-configured", "baseline"], ["gmesh-trusted", "kungfu"]),
    ["gmesh-configured", "baseline", "gmesh-trusted", "kungfu"],
  );
});

test("applyArmIncludeOverrides is idempotent: including an already-present arm is a no-op", () => {
  const base = ["gmesh-configured", "baseline"] as const;
  assert.deepEqual(applyArmIncludeOverrides(base, ["gmesh-configured"]), [...base]);
  assert.deepEqual(applyArmIncludeOverrides(base, []), [...base]);
});
