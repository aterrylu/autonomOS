/**
 * The git branch an agent's working directory is on — derived from the
 * filesystem, so it works for EVERY provider.
 *
 * The agent row's "project · branch" line used to come only from Claude Code's
 * session JSONL (`gitBranch`, via `/api/projects`). Codex and Gemini write no
 * such file, so their rows showed the folder with no branch. Reading the branch
 * straight from `.git` is provider-neutral, and it is also CURRENT — the JSONL
 * value is whatever branch the session last recorded.
 *
 * Pure fs reads, no `git` subprocess: this runs while serializing the agent
 * list and on a background interval, so it must be cheap and must never block
 * on a hung process. Handles a plain repo (`.git/` directory), a worktree or
 * submodule (`.git` FILE → `gitdir: <path>`, whose HEAD is the worktree's own),
 * a detached HEAD (no branch → undefined), and a non-git directory (undefined —
 * the row then shows just the folder, never an error).
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Bound on the upward walk looking for `.git` — deep enough for any real
 *  checkout, finite so a pathological path can't spin. */
const MAX_DEPTH = 40;

const warned = new Set<string>();
function warnOnce(path: string, code: string | undefined): void {
  if (warned.has(path)) return;
  warned.add(path);
  console.warn(
    `[agents] ${path} exists but is unreadable (${code ?? "unknown"}) — branch omitted for agents there`,
  );
}

/** Locate the git dir governing `dir`: walk up to the nearest `.git`, following
 *  a worktree/submodule `gitdir:` pointer. Null when `dir` is not inside a repo. */
function findGitDir(dir: string): string | null {
  let cur = resolve(dir);
  for (let i = 0; i < MAX_DEPTH; i++) {
    const dotGit = join(cur, ".git");
    try {
      const st = statSync(dotGit);
      if (st.isDirectory()) return dotGit;
      if (st.isFile()) {
        const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
        if (!m) return null;
        const target = m[1].trim();
        // A relative gitdir is relative to the directory holding the .git file.
        return isAbsolute(target) ? target : resolve(cur, target);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // A .git EXISTS here but can't be read (EACCES/EPERM/EIO…). Walking on
        // would adopt an ENCLOSING repo's branch (a nested worktree, a dotfiles
        // home) — a wrong value, worse than none. Stop, and say so once.
        warnOnce(dotGit, code);
        return null;
      }
      /* no .git here — keep walking up */
    }
    const parent = dirname(cur);
    if (parent === cur) return null; // filesystem root
    cur = parent;
  }
  return null;
}

/**
 * The branch checked out in `dir`'s repo/worktree, or undefined (not a repo,
 * detached HEAD, unreadable). Never throws.
 */
export function readGitBranch(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    const gitDir = findGitDir(dir);
    if (!gitDir) return undefined;
    const head = readFileSync(join(gitDir, "HEAD"), "utf-8").trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    // A bare sha = detached HEAD → no branch. `.invalid` is the placeholder
    // git writes to HEAD in a reftable-format repo (the real HEAD lives in
    // .git/reftable/, a binary format) — never show it as a branch.
    if (!m || m[1] === ".invalid") return undefined;
    return m[1];
  } catch {
    return undefined;
  }
}

// Short-lived cache: the branch is read on every agent-list serialization, and
// a fleet shares a handful of working directories. The background refresher
// (gitBranchRefresher.ts) reads with `fresh: true` and repopulates it.
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { branch: string | undefined; at: number }>();

export function cachedGitBranch(
  dir: string | undefined,
  { fresh = false }: { fresh?: boolean } = {},
): string | undefined {
  if (!dir) return undefined;
  const now = Date.now();
  const hit = cache.get(dir);
  if (!fresh && hit && now - hit.at < CACHE_TTL_MS) return hit.branch;
  const branch = readGitBranch(dir);
  cache.set(dir, { branch, at: now });
  return branch;
}

/** Test hook. */
export function _resetGitBranchCacheForTesting(): void {
  cache.clear();
}
