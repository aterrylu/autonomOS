/**
 * Git-branch resolver for the dashboard statusline.
 *
 * The per-pane statusline (dashboard chrome) wants each agent's current git
 * branch, but the dashboard runs in the browser and can't shell out. So we
 * resolve it server-side from the agent's working directory and ride it along
 * on the `/api/agents` response.
 *
 * Design constraints:
 *   - `/api/agents` is polled every 5s for ALL agents. Running `git` inline on
 *     every poll × every agent would block the event loop, so resolution is
 *     ASYNC + CACHED: `getCachedBranch()` returns the cached value immediately
 *     (null on a cold cache) and kicks a background refresh when the entry is
 *     stale. The branch surfaces on the next poll — a branch label being ~5s
 *     late is invisible; a blocked event loop is not.
 *   - A branch changes rarely (only when the agent's worktree switches), so a
 *     generous TTL keeps git invocations sparse.
 *   - execFile (never a shell) so the cwd string can't be command-injected.
 *     git intentionally walks up from cwd to the enclosing repo root, so an
 *     agent whose cwd is a subdirectory still resolves its branch. The bound
 *     against a cwd on a slow/networked mount is purely the GIT_TIMEOUT_MS
 *     deadline below — nothing stops the ancestor walk itself, so that timeout
 *     is the one real resource control here; don't relax it.
 *
 * Mirrors the git logic in providers/statusline.mjs (the in-terminal CC
 * statusline), kept separate because that file is a standalone runtime .mjs
 * with no build step and can't be imported here.
 */

import { execFile } from "node:child_process";

/** How long a resolved branch stays fresh before a background refresh. */
const TTL_MS = 30_000;
/** Bound git discovery so a slow/networked-mount cwd can't hang the refresh.
 *  This is the ONLY bound on how far git walks — see the header note. */
const GIT_TIMEOUT_MS = 500;

interface Entry {
  /** Last resolved branch, or null when the cwd isn't a git repo / unreadable. */
  branch: string | null;
  /** When `branch` was last resolved. */
  ts: number;
  /** A refresh is in flight — don't start a second one for the same cwd. */
  refreshing: boolean;
}

/**
 * Outcome of one branch resolution. `ok:true` carries the branch (possibly null
 * for detached HEAD); `ok:false` means the resolver failed and the cache should
 * RETAIN its last-known-good value rather than clobber it — see refresh().
 */
type BranchResult = { ok: true; branch: string | null } | { ok: false };

/** Resolves the branch for a cwd. Injectable so tests can drive the cache logic
 *  without spawning real `git` (real subprocesses under the shared test runner
 *  add CPU contention that flakes timing-sensitive sibling suites). */
type BranchResolver = (cwd: string) => Promise<BranchResult>;

const cache = new Map<string, Entry>();

/** cwds we've already logged an environment fault for — one breadcrumb each,
 *  so a git-missing host doesn't spam the log every 30s × every agent. */
const warnedCwds = new Set<string>();

/** Production resolver: `git branch --show-current` via execFile (no shell). */
const gitResolver: BranchResolver = (cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["branch", "--show-current"],
      { cwd, timeout: GIT_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          // The EXPECTED failures — cwd isn't a git repo, or detached HEAD (git
          // exits 128) — are normal and stay silent. The ENVIRONMENT faults —
          // git not on PATH (ENOENT) or the timeout firing (err.killed) —
          // silently kill the branch segment for EVERY agent, so leave one
          // breadcrumb per cwd ("silently dead on this host" shouldn't be
          // undebuggable). Either way it's ok:false → the cache retains its
          // last-known-good value instead of clobbering it on a blip.
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if ((e.code === "ENOENT" || e.killed) && !warnedCwds.has(cwd)) {
            warnedCwds.add(cwd);
            console.warn(
              `[branchCache] git unavailable/timed out for ${cwd}: ${err.message}`,
            );
          }
          resolve({ ok: false });
          return;
        }
        resolve({ ok: true, branch: stdout.trim() || null });
      },
    );
  });

let resolver: BranchResolver = gitResolver;

function refresh(cwd: string, entry: Entry): void {
  entry.refreshing = true;
  resolver(cwd).then((result) => {
    entry.refreshing = false;
    entry.ts = Date.now();
    // On success, adopt the resolved branch (may be null: detached HEAD). On
    // failure, RETAIN the last-known-good — the label only changes when the
    // branch genuinely changed, never on a transient hiccup.
    if (result.ok) entry.branch = result.branch;
  });
}

/**
 * The cached git branch for `cwd`, or null when unknown/not-a-repo.
 *
 * Non-blocking: returns whatever is cached right now and triggers an async
 * refresh when the entry is missing or stale. First call for a cwd returns null
 * and the value appears on a subsequent poll.
 */
export function getCachedBranch(cwd: string): string | null {
  let entry = cache.get(cwd);
  if (!entry) {
    entry = { branch: null, ts: 0, refreshing: false };
    cache.set(cwd, entry);
  }
  const stale = Date.now() - entry.ts > TTL_MS;
  if (stale && !entry.refreshing) refresh(cwd, entry);
  return entry.branch;
}

/** Test-only: swap the branch resolver (e.g. a synchronous fake, so unit tests
 *  never spawn real git). Pass no argument to restore the production resolver. */
export function _setBranchResolverForTesting(fn?: BranchResolver): void {
  resolver = fn ?? gitResolver;
}

/** Test-only: clear cached branches so cases don't leak into each other. */
export function _resetBranchCacheForTesting(): void {
  cache.clear();
  warnedCwds.clear();
}
