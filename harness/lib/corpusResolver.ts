import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gmeshBinaryPath } from "./mcpConfig.js";
import { timePhase } from "./phaseTimer.js";
import type { CorpusEntry } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Outside the repo (and outside the whole `~/Projects/ClaudeProjects` tree)
 * on purpose, not `<repo>/.cache/corpora` — confirmed empirically that Claude
 * Code's CLAUDE.md/trust resolution treats anything nested under that tree
 * as part of the already-trusted workspace regardless of whether the
 * specific subdirectory is brand new, so a cache dir living inside the repo
 * still leaked `~/.claude/CLAUDE.md` into `claude -p` calls (see resolveWarm's
 * doc comment). `os.tmpdir()` is stable per machine/user, so this still
 * behaves as a real cache across runs, not a fresh dir every time.
 */
const CACHE_ROOT = path.join(tmpdir(), "gmesh-bench-corpora");

/**
 * Every cwd this process has bootstrapped (or reused) a g-mesh daemon for —
 * populated by trackGmeshCwd() below, called from warmGmeshIndex()/
 * writeRepoMap() in this file and from runClaude.ts whenever a call's
 * mcpConfig declares the "g-mesh" server.
 *
 * A single process-wide set rather than a return value threaded through every
 * resolve*()/runArm() call site, because the same cwd is legitimately reused
 * across many (task, arm, repetition) combinations within one corpus (see
 * resolveWarm()'s doc comment) — only the harness's own end-of-run teardown
 * knows a cwd is truly done with, not any one caller mid-loop.
 */
const gmeshTrackedCwds = new Set<string>();

/** Registers `cwd` as one stopTrackedGmeshDaemons() must stop at teardown. */
export function trackGmeshCwd(cwd: string): void {
  gmeshTrackedCwds.add(cwd);
}

/**
 * Runs `g-mesh stop` against every cwd this process bootstrapped a daemon
 * for — see task #16: the harness never called this at all, so every (task,
 * arm, repetition) touching a g-mesh arm left a perfectly healthy daemon
 * alive for the full 24h `coreIdleTimeoutHours`. Meant to be called once, at
 * the same place each entry point (token-economy.ts/session-economy.ts)
 * already tears its run down.
 *
 * Best-effort per cwd: one daemon that fails to stop (already gone, a
 * permissions hiccup, whatever) must not stop this from stopping the rest,
 * and must not fail an otherwise-successful benchmark run over pure cleanup.
 * `g-mesh stop` is itself a documented no-op (exit 0) against a cwd with
 * nothing running, so calling it for every tracked cwd — including ones a
 * particular arm never actually queried — costs nothing but a wasted process
 * spawn.
 *
 * Not a substitute for the coreIdleTimeoutHours backstop (see mcpConfig.ts's
 * gmeshCoreIdleTimeoutMs) — this only runs on a clean exit; a killed or
 * crashed harness process never reaches it, which is exactly the gap that
 * backstop covers.
 */
export async function stopTrackedGmeshDaemons(): Promise<void> {
  const cwds = [...gmeshTrackedCwds];
  gmeshTrackedCwds.clear();
  for (const cwd of cwds) {
    try {
      const { stdout } = await execFileAsync(gmeshBinaryPath(), ["stop"], { cwd });
      console.log(`  g-mesh stop (${cwd}): ${stdout.trim().split("\n")[0]}`);
    } catch (err) {
      console.warn(`  g-mesh stop failed for ${cwd}: ${(err as Error).message}`);
    }
  }
}

/**
 * Every corpus revision this process has resolved, keyed by corpus id.
 *
 * The memo is the actual mechanism that makes arms comparable, not an
 * optimization: resolveCorpusRevision() is called from every clone path
 * (warm, fresh, configured) and from the experiment entry points that stamp
 * the revision onto their result records, so a single memoized answer per
 * process is what guarantees that `baseline`'s checkout, `gmesh-configured`'s
 * throwaway clone and the recorded `corpusRevision` are all the same commit —
 * even for an unpinned `kind: "local"` corpus whose source repo receives a
 * commit halfway through a 15-hour sweep.
 *
 * Task #116: before this existed, `baseline` ran from a CACHE_ROOT clone made
 * once and never refreshed while the `-configured` arms cloned the registry
 * path's current HEAD on every invocation, so a sweep silently compared arms
 * against different code (visibly so in the 2026-08-16 sweep, where every
 * baseline answer cited `cancelTask` at line 372 and every g-mesh answer at
 * line 425 — both correct, different checkouts).
 */
const resolvedRevisions = new Map<string, string>();

function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

async function computeCorpusRevision(entry: CorpusEntry): Promise<string> {
  if (entry.kind === "local") {
    if (!entry.path) throw new Error(`corpus ${entry.id} is kind=local but missing path`);
    // `^{commit}` so a tag or branch name resolves to the commit it points at
    // rather than to a tag object, and so a bad `revision` fails here — once,
    // loudly, before anything is cloned or any money is spent — instead of at
    // the first checkout.
    const requested = entry.revision ?? "HEAD";
    try {
      const { stdout } = await execFileAsync("git", ["-C", entry.path, "rev-parse", `${requested}^{commit}`]);
      return stdout.trim();
    } catch (err) {
      throw new Error(
        `corpus ${entry.id}: cannot resolve revision "${requested}" in ${entry.path} ` +
          `(${(err as Error).message.trim()}). Fix corpora/registry.json's "revision", or fetch it in that checkout.`,
      );
    }
  }
  if (!entry.repoUrl) throw new Error(`corpus ${entry.id} is kind=git but missing repoUrl`);
  const requested = entry.revision ?? entry.ref;
  if (!requested) throw new Error(`corpus ${entry.id} is kind=git but missing revision/ref`);
  if (isCommitSha(requested)) return requested;
  // A branch or tag name still has to be turned into a commit *once*, here,
  // for the same reason the memo above exists: resolving it per clone would
  // let two arms of one run land on different commits of a moving branch.
  const { stdout } = await execFileAsync("git", ["ls-remote", entry.repoUrl, requested]);
  const sha = stdout.split(/\s+/)[0];
  if (sha === undefined || !isCommitSha(sha)) {
    throw new Error(`corpus ${entry.id}: git ls-remote ${entry.repoUrl} ${requested} resolved no commit`);
  }
  return sha;
}

/**
 * The one commit every checkout of `entry` in this process is pinned to, and
 * the value experiments record as `corpusRevision`.
 *
 * `revision` in corpora/registry.json is the pin; without one, a `kind:
 * "local"` corpus resolves its source checkout's current HEAD and a `kind:
 * "git"` corpus resolves its `ref`. Unpinned is supported (adding a corpus
 * shouldn't require hunting a SHA first) but warned about, because ground
 * truth in this benchmark is content-anchored — `mode: "pool"` candidate
 * pools are exact file lists, and `mode: "test"` tasks are premised on a bug
 * that exists in a particular revision — so a corpus that tracks HEAD grades
 * against ground truth that rots without anyone noticing. See README's
 * "Pin the corpus to a revision".
 */
export async function resolveCorpusRevision(entry: CorpusEntry): Promise<string> {
  const memoized = resolvedRevisions.get(entry.id);
  if (memoized !== undefined) return memoized;
  const revision = await computeCorpusRevision(entry);
  resolvedRevisions.set(entry.id, revision);
  if (entry.revision === undefined) {
    console.warn(
      `  ! corpus ${entry.id} has no "revision" pin in corpora/registry.json; using ${revision} ` +
        `(resolved once for this run). Results stay internally consistent, but this corpus's ground truth ` +
        `is not protected against upstream commits — pin it to keep past runs reproducible.`,
    );
  }
  return revision;
}

/**
 * Drops the per-process revision memo. Exists for tests only — the memo is
 * deliberately process-wide (see resolvedRevisions), so a test that needs to
 * observe a *second* resolution of the same corpus id has no other way to get
 * one. Same test-only-reset precedent as benchConfig.ts's
 * resetBenchConfigCache(). Never call this mid-run: a run that re-resolves a
 * corpus can pin two arms to two commits, which is exactly the bug this file
 * fixes.
 */
export function resetResolvedRevisionsCache(): void {
  resolvedRevisions.clear();
}

/**
 * Puts an already-cloned `dest` on exactly `revision`, detached.
 *
 * `--force` because this is also the refresh path for the reused warm cache:
 * whatever a previous run's arm left modified in there is not part of the
 * corpus and must not survive into the next run's measurement.
 */
async function checkoutRevision(entry: CorpusEntry, dest: string, revision: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", dest, "checkout", "--detach", "--force", revision]);
  } catch (err) {
    throw new Error(
      `corpus ${entry.id}: checkout ${dest} does not contain revision ${revision} ` +
        `(${(err as Error).message.trim()}). If this is the warm cache, delete ${dest} and re-run.`,
    );
  }
}

async function cloneAt(entry: CorpusEntry, dest: string, revision: string): Promise<void> {
  if (!entry.repoUrl) {
    throw new Error(`corpus ${entry.id} is kind=git but missing repoUrl`);
  }
  await execFileAsync("git", ["clone", entry.repoUrl, dest]);
  await checkoutRevision(entry, dest, revision);
}

/** Clones from a local git working copy — tracked files only, no node_modules/.git bloat. */
async function cloneLocal(entry: CorpusEntry, sourcePath: string, dest: string, revision: string): Promise<void> {
  await execFileAsync("git", ["clone", sourcePath, dest]);
  await checkoutRevision(entry, dest, revision);
}

/**
 * Every clone path funnels through here so "which commit" is decided in one
 * place: an arm can only ever get the revision resolveCorpusRevision() settled
 * for this process, whatever route it took to a directory.
 */
async function cloneCorpus(entry: CorpusEntry, dest: string, revision: string): Promise<void> {
  await timePhase("corpus.clone", async () => {
    if (entry.kind === "local") {
      if (!entry.path) throw new Error(`corpus ${entry.id} is kind=local but missing path`);
      await cloneLocal(entry, entry.path, dest, revision);
      return;
    }
    await cloneAt(entry, dest, revision);
  });
}

/**
 * Reused checkout for warm experiments (search-latency, token-economy).
 *
 * Always a `CACHE_ROOT` clone, never `entry.path` itself for `kind: "local"`
 * — `--setting-sources project` does not gate CLAUDE.md loading, and handing
 * an arm the live, registry-registered checkout (nested under the operator's
 * trusted workspace tree, see CACHE_ROOT's doc comment) as its cwd was
 * silently leaking `~/.claude/CLAUDE.md` into every run. That's exactly why
 * 80% of `baseline`-arm results replied in Russian (this machine's global
 * CLAUDE.md says to) while `gmesh-configured`/`serena` — which always ran
 * from a `CACHE_ROOT`/mkdtemp clone — never did once.
 *
 * Reused, but no longer *stale*: the cache is checked against this run's
 * resolveCorpusRevision() and hard-checked-out onto it when it differs (task
 * #116). Before that, this clone was made once and never touched again, so
 * the arms that run from here — `baseline` above all — measured whatever the
 * corpus looked like on the day the cache directory was first created, while
 * every mkdtemp-cloning arm measured current HEAD. The reuse itself is still
 * the point (a shared path keeps g-mesh's index and any installed
 * node_modules warm across runs); only the "never refreshed" part was the bug.
 */
export async function resolveWarm(entry: CorpusEntry): Promise<string> {
  const revision = await resolveCorpusRevision(entry);
  const dest = path.join(CACHE_ROOT, entry.id);
  await mkdir(CACHE_ROOT, { recursive: true });
  let cachedHead: string | undefined;
  try {
    const { stdout } = await execFileAsync("git", ["-C", dest, "rev-parse", "HEAD"]);
    cachedHead = stdout.trim();
  } catch {
    cachedHead = undefined;
  }
  if (cachedHead === undefined) {
    await cloneCorpus(entry, dest, revision);
    return dest;
  }
  if (cachedHead !== revision) {
    console.log(`  warm ${entry.id} cache: ${cachedHead.slice(0, 8)} -> ${revision.slice(0, 8)} (refreshing)`);
    // Best-effort: the fetch only matters when the pinned commit isn't in the
    // cached clone yet, and the checkout below is what actually decides —
    // failing here on a network/offline hiccup while the commit is already
    // present would abort a run that could have proceeded.
    await timePhase("corpus.refresh", async () => {
      try {
        await execFileAsync("git", ["-C", dest, "fetch", "--quiet", "origin"]);
      } catch (err) {
        console.warn(`  fetch into the warm ${entry.id} cache failed: ${(err as Error).message.trim()}`);
      }
      await checkoutRevision(entry, dest, revision);
    });
  }
  return dest;
}

/** Fresh throwaway checkout guaranteeing no prior g-mesh index exists for this path (cold-start). */
export async function resolveFresh(entry: CorpusEntry): Promise<string> {
  const revision = await resolveCorpusRevision(entry);
  // mkdtemp already created `dest` as an empty dir; git clone refuses to clone into
  // a non-empty one but is fine with an existing *empty* one.
  const dest = await mkdtemp(path.join(tmpdir(), `gmesh-bench-${entry.id}-`));
  await cloneCorpus(entry, dest, revision);
  return dest;
}

/**
 * Throwaway clone (same resolveFresh() mechanism kungfu's cwd already uses,
 * for the identical reason — must never write into the live,
 * registry-registered checkout) with a `-configured` arm's real project setup
 * written into it, so that arm exercises Claude Code's actual
 * `--setting-sources project` auto-discovery instead of a harness-injected
 * prompt suffix.
 *
 * Both inputs are optional and independent, because the three `-configured`
 * arms deliver their setup differently: gmesh-configured and kungfu-configured
 * ship guidance as a project `CLAUDE.md`, serena-configured ships Serena's own
 * `serena-hooks` wiring as `.claude/settings.json` (armConfig.ts's
 * SERENA_CONFIGURED_SETTINGS_JSON) and no doc at all. Passing neither is a
 * plain resolveFresh() and is not rejected here — an arm may legitimately want
 * the throwaway-clone half on its own.
 *
 * CLAUDE.md is *appended* to when one already exists — the excalidraw corpus
 * has its own real project CLAUDE.md about monorepo/build conventions, and
 * appending mirrors how a real user would add a recommendation to an existing
 * project rather than clobbering their own instructions.
 *
 * `.claude/settings.json` deliberately does the opposite and *throws* on a
 * pre-existing file. There is no append for JSON, and the two plausible merges
 * (deep-merging hook arrays, or letting one side win) would each silently
 * produce a settings file neither the corpus author nor this harness wrote —
 * i.e. an arm running under a configuration nobody can read off either source.
 * Neither shipped corpus has one today, so hitting this is a genuine
 * "a human has to decide" signal rather than an expected case.
 */
export async function resolveConfigured(
  entry: CorpusEntry,
  claudeMd?: string,
  settingsJson?: object,
): Promise<string> {
  const dest = await resolveFresh(entry);
  if (claudeMd !== undefined) {
    const claudeMdPath = path.join(dest, "CLAUDE.md");
    if (existsSync(claudeMdPath)) {
      const existing = await readFile(claudeMdPath, "utf-8");
      await writeFile(claudeMdPath, `${existing}\n\n${claudeMd}`);
    } else {
      await writeFile(claudeMdPath, claudeMd);
    }
  }
  if (settingsJson !== undefined) {
    const settingsPath = path.join(dest, ".claude", "settings.json");
    if (existsSync(settingsPath)) {
      throw new Error(
        `Corpus ${entry.id} already ships a .claude/settings.json; refusing to overwrite or merge it ` +
          `(${settingsPath}). Decide by hand what the configured arm's settings should be.`,
      );
    }
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(settingsJson, null, 2)}\n`);
  }
  return dest;
}

/**
 * Marker the repo-map block is wrapped in, straight from g-mesh's
 * `cli::agent_instructions` (REPO_MAP_BEGIN_MARKER). Duplicated here rather
 * than parsed out of the binary because this harness needs it for exactly one
 * thing: proving, after the fact, that the block really landed in the file.
 */
const REPO_MAP_BEGIN_MARKER = "<!-- g-mesh:repo-map:begin -->";

/**
 * Writes g-mesh's repo map into `cwd`'s `AGENTS.md`, the real delivery channel
 * the feature ships (see g-mesh/docs/architecture/pushed-context-repo-map.md,
 * C1) — this is what makes an arm the `gmesh-configured-map` arm rather than a
 * second copy of `gmesh-configured`.
 *
 * Two things it has to do that `g-mesh map --write` does not do for itself:
 *
 * - **Create `AGENTS.md` when the corpus has none.** `ensure_repo_map_block`
 *   returns `Ok(false)` — a silent no-op — on a project with no `AGENTS.md`,
 *   because in production `g-mesh init --agent` is the only thing allowed to
 *   create that file. Neither bench corpus ships one, so without this the map
 *   arm would run with no map at all and still look healthy. The seeded file is
 *   a single heading, so nothing but the map block is added to the arm's
 *   context.
 * - **Fail loudly.** Unlike warmGmeshIndex() above, this is not best-effort: a
 *   map arm that silently ran mapless would not degrade the experiment, it
 *   would invalidate it. Every failure path throws, and the marker check below
 *   is deliberately made against the file on disk rather than against the
 *   command's own exit code.
 *
 * Requires a warm index: `g-mesh map` reads `index.db` directly and refuses to
 * emit a partial map while the bulk walk is unfinished, so callers must
 * warmGmeshIndex() first.
 */
export async function writeRepoMap(cwd: string, tokens: number): Promise<void> {
  trackGmeshCwd(cwd);
  const agentsMdPath = path.join(cwd, "AGENTS.md");
  if (!existsSync(agentsMdPath)) {
    await writeFile(agentsMdPath, "# AGENTS.md\n");
  }
  const start = performance.now();
  const { stdout } = await timePhase("gmesh.map", () =>
    execFileAsync(gmeshBinaryPath(), ["map", "--write", "--tokens", String(tokens)], { cwd }),
  );
  const written = await readFile(agentsMdPath, "utf-8");
  if (!written.includes(REPO_MAP_BEGIN_MARKER)) {
    throw new Error(
      `g-mesh map --write reported success in ${cwd} but left no ${REPO_MAP_BEGIN_MARKER} block in AGENTS.md. ` +
        `Refusing to run the map arm without a map (binary: ${gmeshBinaryPath()}).`,
    );
  }
  console.log(
    `  repo map written (${tokens}-token budget, ${written.length} B AGENTS.md, ` +
      `${(performance.now() - start).toFixed(0)}ms): ${stdout.trim()}`,
  );
}

/**
 * Runs `g-mesh init` in `cwd` so its g-mesh index is fully built before any
 * measured `claude -p` call touches this cwd. Idempotent (a project already
 * fully walked skips the bulk walk), so this is cheap on an already-warm cwd
 * and pays a real walk up front on a brand-new one - instead of that walk
 * leaking into the measured call's turn count, which is exactly what a real
 * repro of `ex-namespace-import-laserpointer-plerp` under `gmesh-configured`
 * showed: the one g-mesh tool call the model made hit the daemon's own
 * "index is still being built, retry" placeholder mid cold-start walk, and
 * the model fell back to Grep instead of retrying.
 *
 * Deliberately not folded into resolveConfigured()/resolveFresh()/
 * resolveWarm() themselves: resolveConfigured() is shared verbatim by the
 * kungfu-configured and serena-configured arms, neither of which touches
 * g-mesh at all, and
 * resolveFresh() is used directly by non-gmesh arms too - baking warming in
 * there would burn a walk on cwds nothing will ever query via g-mesh. Callers
 * warm explicitly, only for cwds a gmesh-backed arm will actually use.
 *
 * Best-effort: caught and logged rather than thrown, so a failure here
 * degrades to today's (already-shipped) possibly-cold behavior for this one
 * cwd rather than aborting an entire multi-corpus benchmark run over one
 * warm-up call. No timeout - the whole point is to actually wait for the
 * walk to finish, same reasoning as mcpClient.ts's 5-minute
 * CONNECT_TIMEOUT_MS.
 */
export async function warmGmeshIndex(cwd: string): Promise<void> {
  trackGmeshCwd(cwd);
  const start = performance.now();
  try {
    await timePhase("gmesh.index", () => execFileAsync(gmeshBinaryPath(), ["init"], { cwd }));
    console.log(`  g-mesh index warm (${(performance.now() - start).toFixed(0)}ms): ${cwd}`);
  } catch (err) {
    console.warn(
      `  g-mesh init failed for ${cwd}; continuing with a possibly cold index: ${(err as Error).message}`,
    );
  }
}
