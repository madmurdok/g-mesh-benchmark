import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gmeshBinaryPath } from "./mcpConfig.js";
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

async function cloneAt(entry: CorpusEntry, dest: string): Promise<void> {
  if (!entry.repoUrl || !entry.ref) {
    throw new Error(`corpus ${entry.id} is kind=git but missing repoUrl/ref`);
  }
  await execFileAsync("git", ["clone", entry.repoUrl, dest]);
  await execFileAsync("git", ["checkout", entry.ref], { cwd: dest });
}

/** Clones from a local git working copy — tracked files only, no node_modules/.git bloat. */
async function cloneLocal(sourcePath: string, dest: string): Promise<void> {
  await execFileAsync("git", ["clone", sourcePath, dest]);
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
 */
export async function resolveWarm(entry: CorpusEntry): Promise<string> {
  const dest = path.join(CACHE_ROOT, entry.id);
  await mkdir(CACHE_ROOT, { recursive: true });
  try {
    await execFileAsync("git", ["-C", dest, "rev-parse", "HEAD"]);
  } catch {
    if (entry.kind === "local") {
      if (!entry.path) throw new Error(`corpus ${entry.id} is kind=local but missing path`);
      await cloneLocal(entry.path, dest);
    } else {
      await cloneAt(entry, dest);
    }
  }
  return dest;
}

/** Fresh throwaway checkout guaranteeing no prior g-mesh index exists for this path (cold-start). */
export async function resolveFresh(entry: CorpusEntry): Promise<string> {
  const dest = await mkdtemp(path.join(tmpdir(), `gmesh-bench-${entry.id}-`));
  if (entry.kind === "local") {
    if (!entry.path) throw new Error(`corpus ${entry.id} is kind=local but missing path`);
    // mkdtemp already created `dest` as an empty dir; git clone refuses to clone into
    // a non-empty one but is fine with an existing *empty* one.
    await cloneLocal(entry.path, dest);
    return dest;
  }
  await cloneAt(entry, dest);
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
  const start = performance.now();
  try {
    await execFileAsync(gmeshBinaryPath(), ["init"], { cwd });
    console.log(`  g-mesh index warm (${(performance.now() - start).toFixed(0)}ms): ${cwd}`);
  } catch (err) {
    console.warn(
      `  g-mesh init failed for ${cwd}; continuing with a possibly cold index: ${(err as Error).message}`,
    );
  }
}
