import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { walkCodeStats } from "./cold-start.js";
import type { CorpusEntry } from "./lib/types.js";

/**
 * GMB-164: cold-start.ts's indexable-file walk is keyed off the corpus's own
 * declared language (lib/language.ts) instead of a hardcoded TS/JS extension
 * list. Before this fix, running the walk against a Go-only tree silently
 * counted zero indexable files — which reads as a *fast* cold start, not as
 * "no measurement" — because the walk had no way to know it should be
 * looking for `.go`.
 *
 * Uses a real, non-TS checkout (GMB-163's probe corpus) rather than a
 * synthetic fixture: walkCodeStats reads real file contents off disk, and a
 * synthetic tree risks accidentally proving something about an empty
 * directory rather than a real Go project's file layout.
 *
 * Run: npx tsx harness/cold-start.test.ts
 * (no test runner is wired into package.json in this repo).
 */

const GO_GIN_DIR =
  "/private/tmp/claude-502/-Users-Valentin-Taiurskii-Projects-ClaudeProjects/" +
  "4685644a-9ee3-40ec-b6dc-0dea1c805d33/scratchpad/probe/go-gin";

const goCorpus: CorpusEntry = { id: "probe-go-gin", kind: "local", language: "go" };
const tsCorpus: CorpusEntry = { id: "probe-go-gin-as-ts", kind: "local", language: "ts" };

test("walkCodeStats counts .go files for a corpus declared language 'go'", { skip: !existsSync(GO_GIN_DIR) }, async () => {
  const stats = await walkCodeStats(GO_GIN_DIR, goCorpus);

  assert.ok(stats.fileCount > 0, "a real Go checkout must contain at least one indexable file");
  assert.ok(stats.locCount > 0);
  assert.ok(stats.sampleRelPath !== null);
  assert.match(stats.sampleRelPath as string, /\.go$/);
});

test(
  "walkCodeStats finds nothing in the same Go tree under the ts/js default — the two arms must differ",
  { skip: !existsSync(GO_GIN_DIR) },
  async () => {
    // go-gin has zero .ts/.tsx/.js/.jsx files (confirmed: `find ... -name
    // '*.ts' -o -name '*.js' ...` returns nothing), so this is the same walk,
    // same directory, differing only in which corpus.language is declared —
    // exactly the axis GMB-164 fixed.
    const stats = await walkCodeStats(GO_GIN_DIR, tsCorpus);

    assert.equal(stats.fileCount, 0);
    assert.equal(stats.sampleRelPath, null);
  },
);
