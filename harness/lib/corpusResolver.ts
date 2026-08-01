import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
