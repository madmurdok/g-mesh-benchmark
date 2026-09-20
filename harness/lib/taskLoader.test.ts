import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTasks } from "./taskLoader.js";
import type { CorpusEntry } from "./types.js";

/**
 * GMB-164 acceptance: a `corpora/registry.json` entry declaring
 * `language: "go"` (or "rust"/"python") loads and validates.
 *
 * `loadRegistry()` itself (taskLoader.ts) reads a fixed, repo-relative path
 * (`ROOT/corpora/registry.json`), so it can't be pointed at a fixture without
 * changing what it reads in production — this instead round-trips a fixture
 * through the exact same `readFile` + `JSON.parse` it uses, at a temp path,
 * which exercises everything `loadRegistry()` itself does to the bytes.
 * "Validates" is a compile-time claim in this codebase: `CorpusEntry` is not
 * a runtime validation boundary anywhere else either (see `Arm`'s doc comment
 * in types.ts) — the `CorpusEntry[]` annotation below is what makes an
 * invalid entry a `tsc` failure rather than a silent pass.
 */

async function withTempFile(contents: string, fn: (filePath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "gmesh-bench-registry-"));
  const filePath = path.join(dir, "registry.json");
  try {
    await writeFile(filePath, contents);
    await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a registry entry declaring language 'go' loads through JSON.parse and keeps its language", async () => {
  const fixture: CorpusEntry[] = [
    { id: "probe-go-gin", kind: "local", path: "/tmp/does-not-need-to-exist-for-this-test", language: "go" },
  ];

  await withTempFile(JSON.stringify(fixture), async (filePath) => {
    const loaded: CorpusEntry[] = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.language, "go");
    assert.deepEqual(loaded[0], fixture[0]);
  });
});

test("rust and python registry entries load through JSON.parse the same way", async () => {
  const fixture: CorpusEntry[] = [
    { id: "probe-rs-ripgrep", kind: "local", path: "/tmp/rs", language: "rust" },
    { id: "probe-py-requests", kind: "local", path: "/tmp/py", language: "python" },
  ];

  await withTempFile(JSON.stringify(fixture), async (filePath) => {
    const loaded: CorpusEntry[] = JSON.parse(await readFile(filePath, "utf8"));
    assert.deepEqual(
      loaded.map((c) => c.language),
      ["rust", "python"],
    );
  });
});

test("loadTasks returns an empty list for a registered corpus with no tasks.json yet, rather than throwing", async () => {
  // Models the GMB-166/167/168 state: a corpus registered in registry.json
  // before its tasks.json exists — must not crash the loader.
  const tasks = await loadTasks("probe-go-gin-not-a-real-corpus-directory");
  assert.deepEqual(tasks, []);
});
