import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gmeshBinaryPath } from "./mcpConfig.js";
import type { CorpusEntry } from "./types.js";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_ROOT = path.resolve(HERE, "../../.cache/corpora");

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

/** Reused checkout for warm experiments (search-latency, token-economy). */
export async function resolveWarm(entry: CorpusEntry): Promise<string> {
  if (entry.kind === "local") {
    if (!entry.path) throw new Error(`corpus ${entry.id} is kind=local but missing path`);
    return entry.path;
  }
  const dest = path.join(CACHE_ROOT, entry.id);
  await mkdir(CACHE_ROOT, { recursive: true });
  try {
    await execFileAsync("git", ["-C", dest, "rev-parse", "HEAD"]);
  } catch {
    await cloneAt(entry, dest);
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
 * registry-registered checkout) with a real project CLAUDE.md written into
 * it, so the gmesh-configured arm exercises Claude Code's actual
 * `--setting-sources project` auto-discovery instead of a harness-injected
 * prompt suffix.
 *
 * Appends to an existing CLAUDE.md rather than overwriting it — the
 * excalidraw corpus has its own real project CLAUDE.md about monorepo/build
 * conventions, and appending mirrors how a real user would actually add this
 * recommendation to an existing project rather than clobbering their own
 * instructions.
 */
export async function resolveConfigured(entry: CorpusEntry, claudeMd: string): Promise<string> {
  const dest = await resolveFresh(entry);
  const claudeMdPath = path.join(dest, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const existing = await readFile(claudeMdPath, "utf-8");
    await writeFile(claudeMdPath, `${existing}\n\n${claudeMd}`);
  } else {
    await writeFile(claudeMdPath, claudeMd);
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
 * kungfu-configured arm, which never touches g-mesh at all, and
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
