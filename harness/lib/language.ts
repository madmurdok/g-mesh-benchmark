import type { CorpusLanguage } from "./types.js";

/**
 * Source-file extensions (dotted) for each `CorpusLanguage` a corpus can
 * declare in `corpora/registry.json` — the harness's single definition of
 * "a file that belongs to this corpus's language".
 *
 * Before GMB-164, cold-start.ts's indexable-file walk, testRunner.ts's
 * testCommand path parser and runClaude.ts's file-mention regex each
 * hardcoded their own TS/JS-shaped extension list, which is why a Go, Rust or
 * Python corpus produced silently-wrong numbers (zero indexable files reading
 * as a fast cold start, not as "no measurement") rather than an error: none
 * of those lists had a language to key off in the first place, since
 * `CorpusEntry.language` only ever admitted "ts" | "js". Every one of those
 * consumers now derives its own extension list from this map instead, so
 * adding a language is a one-line change here rather than three.
 *
 * `ts` and `js` share one list on purpose: a real project declared under
 * either name mixes both extensions in practice (JSX, build configs, mjs/cjs
 * interop) — this repo's own two registered corpora (task-tracker-mcp,
 * excalidraw) are both declared "ts" and both contain plain `.js` files.
 */
export const LANGUAGE_EXTENSIONS: Record<CorpusLanguage, readonly string[]> = {
  ts: [".ts", ".tsx", ".js", ".jsx"],
  js: [".ts", ".tsx", ".js", ".jsx"],
  go: [".go"],
  rust: [".rs"],
  python: [".py"],
};
