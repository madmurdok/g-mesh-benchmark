/*
 * GMB-171. The default g-mesh binary path stopped being a build output when
 * g-mesh became a cargo workspace, and nothing noticed, because the artifact
 * from before the restructure was still sitting there: the path resolved, the
 * run started, and it measured a binary five minor versions old while
 * reporting that binary's version perfectly correctly.
 *
 * So the thing worth testing is not that the new path string is right — a
 * string compare would pass on a path nothing builds either. It is that a
 * default which resolves to something older than the checkout it claims to
 * come from is *refused*, and that an explicit override is not, because
 * every A/B control in this project is a deliberately stale binary.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertBinaryIsCurrent, assertGmeshBinaryUsable, gmeshBinaryPath } from "./mcpConfig.js";

/** A throwaway git repo whose single commit is `committedAt`. */
function repoWithOneCommit(committedAt: Date): string {
  const repo = mkdtempSync(path.join(tmpdir(), "gmb171-repo-"));
  const when = committedAt.toISOString();
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_DATE: when,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  execFileSync("git", ["-C", repo, "init", "-q"], { env });
  writeFileSync(path.join(repo, "f"), "x");
  execFileSync("git", ["-C", repo, "add", "f"], { env });
  execFileSync("git", ["-C", repo, "commit", "-qm", "c"], { env });
  return repo;
}

/** A file standing in for a built binary, with its mtime set to `builtAt`. */
function binaryBuiltAt(builtAt: Date): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gmb171-bin-"));
  const binary = path.join(dir, "g-mesh");
  writeFileSync(binary, "#!/bin/sh\nexit 1\n");
  utimesSync(binary, builtAt, builtAt);
  return binary;
}

const HEAD_AT = new Date("2026-09-16T12:00:00Z");

test("a binary older than the checkout's HEAD is refused, naming both", () => {
  const repo = repoWithOneCommit(HEAD_AT);
  const stale = binaryBuiltAt(new Date("2026-08-27T09:00:00Z"));

  assert.throws(
    () => assertBinaryIsCurrent(stale, repo),
    (err: Error) => {
      // The whole point is that the message identifies both sides, so the
      // reader does not have to go and find out which of them is wrong.
      assert.match(err.message, /older than the checkout/);
      assert.ok(err.message.includes(stale), err.message);
      assert.ok(err.message.includes(repo), err.message);
      assert.match(err.message, /built 2026-08-27T09:00:00/);
      assert.match(err.message, /HEAD committed 2026-09-16T12:00:00/);
      assert.match(err.message, /G_MESH_BENCH_BINARY/);
      return true;
    },
  );
});

test("a binary built after the checkout's HEAD is accepted", () => {
  const repo = repoWithOneCommit(HEAD_AT);
  const fresh = binaryBuiltAt(new Date("2026-09-21T09:00:00Z"));

  assert.doesNotThrow(() => assertBinaryIsCurrent(fresh, repo));
});

test("a default that does not exist is refused with the build command", () => {
  const repo = repoWithOneCommit(HEAD_AT);
  const missing = path.join(repo, "target", "release", "g-mesh");

  assert.throws(
    () => assertBinaryIsCurrent(missing, repo),
    (err: Error) => {
      assert.match(err.message, /binary not found/);
      assert.ok(err.message.includes(missing), err.message);
      assert.match(err.message, /cargo build --release -p g-mesh/);
      return true;
    },
  );
});

test("an unreadable checkout leaves the age question unasked rather than answered", () => {
  // No git repo at all: the check cannot know whether the binary is stale, so
  // it must not invent an answer in either direction. Refusing here would
  // break every run made outside a g-mesh checkout.
  const notARepo = mkdtempSync(path.join(tmpdir(), "gmb171-norepo-"));
  const ancient = binaryBuiltAt(new Date("2020-01-01T00:00:00Z"));

  assert.doesNotThrow(() => assertBinaryIsCurrent(ancient, notARepo));
});

test("an explicit G_MESH_BENCH_BINARY is accepted however old, but must exist", () => {
  // Deliberately stale binaries are the A/B control workflow, not a mistake:
  // g-mesh's GM-372 and GM-378 each built one before their fix and measured
  // against it. Age-checking the override would break exactly that.
  const ancient = binaryBuiltAt(new Date("2020-01-01T00:00:00Z"));
  const before = process.env.G_MESH_BENCH_BINARY;
  try {
    process.env.G_MESH_BENCH_BINARY = ancient;
    assert.equal(gmeshBinaryPath(), ancient);
    assert.equal(assertGmeshBinaryUsable(), ancient);

    process.env.G_MESH_BENCH_BINARY = path.join(ancient, "nope");
    assert.throws(() => assertGmeshBinaryUsable(), /does not exist/);
  } finally {
    if (before === undefined) delete process.env.G_MESH_BENCH_BINARY;
    else process.env.G_MESH_BENCH_BINARY = before;
  }
});

test("naming the path never runs a build check", () => {
  // The regression this refactor exists for: armConfig.test.ts only builds an
  // MCP config, and briefly could not, because gmeshBinaryPath() had started
  // asserting that someone had run `cargo build --release`.
  const before = process.env.G_MESH_BENCH_BINARY;
  try {
    delete process.env.G_MESH_BENCH_BINARY;
    assert.doesNotThrow(() => gmeshBinaryPath());
    assert.match(gmeshBinaryPath(), /g-mesh\/target\/release\/g-mesh$/);
  } finally {
    if (before !== undefined) process.env.G_MESH_BENCH_BINARY = before;
  }
});
