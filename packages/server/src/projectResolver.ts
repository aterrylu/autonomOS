/**
 * Which PROJECT a session's working directory belongs to, for the Projects
 * panel: its git repository (a worktree folds into its main repo, like the
 * Codex and Claude apps), a plain directory, or a throwaway temp dir.
 *
 * Measured on the operator's real history: most session directories no
 * longer EXIST (wt-sync deletes merged worktrees; temp dirs vanish), and
 * `git rev-parse` costs tens of ms per dir on a loaded box. So:
 *
 *  1. TEMP is classified first, by path alone — throwaway git repos in /tmp
 *     must not surface as "repos".
 *  2. Git resolution runs OFF the request path (bounded concurrency, timeout,
 *     no network) into a cache; `resolveDir` only reads the cache, and a dir
 *     not yet resolved is a plain "dir" until a later poll.
 *  3. Every root git resolves is PERSISTED (cwd → repoRoot), so a worktree
 *     learned while it existed keeps its repo after it's deleted.
 *  4. A dir deleted before it was ever seen falls back to the worktree-manager
 *     convention `~/.claude-worktrees/<repo>-<branch>` → the KNOWN repo whose
 *     basename is the longest such prefix.
 */

import { execFile } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { getConfigDir } from "./configDir.js";

export type ProjectKind = "repo" | "dir" | "temp";
export type RepoResolvedBy = "git" | "learned" | "convention";

export interface DirResolution {
  kind: ProjectKind;
  /** The repository's root (the MAIN repo for a worktree), for kind "repo". */
  repoRoot?: string;
  resolvedBy?: RepoResolvedBy;
}

/** Git calls in flight at once, and each one's bound. */
const GIT_CONCURRENCY = 4;
const GIT_TIMEOUT_MS = 2_000;
/** How long "not a git dir" is trusted before re-checking (it may become one). */
const NEGATIVE_TTL_MS = 10 * 60_000;

// ── temp ────────────────────────────────────────────────────────

/** Throwaway locations: never a project of their own. */
export function isTempDir(path: string, tmp = tmpdir()): boolean {
  const p = path.endsWith(sep) ? path : `${path}${sep}`;
  const roots = [
    "/tmp/",
    "/private/tmp/",
    "/var/folders/",
    "/private/var/folders/",
    tmp.endsWith(sep) ? tmp : `${tmp}${sep}`,
  ];
  if (roots.some((r) => p.startsWith(r))) return true;
  return /[/\\]scratchpad([/\\]|$)/.test(path);
}

// ── the learned map (persisted) ─────────────────────────────────

let learned: Map<string, string> | undefined;
let learnedDirty = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function learnedFile(): string {
  return join(getConfigDir(), "project-roots.json");
}

function loadLearned(): Map<string, string> {
  if (learned) return learned;
  learned = new Map();
  try {
    const raw = JSON.parse(readFileSync(learnedFile(), "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw))
        if (typeof v === "string") learned.set(k, v);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      console.warn(
        `[projects] ignoring unreadable ${learnedFile()}: ${(err as Error).message}`,
      );
  }
  return learned;
}

function scheduleSave(): void {
  learnedDirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(saveNow, 1_000);
  saveTimer.unref?.();
}

/** Write the learned map (atomic: tmp file + rename, 0600). */
function saveNow(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  if (!learnedDirty || !learned) return;
  learnedDirty = false;
  const file = learnedFile();
  const tmpFile = `${file}.tmp`;
  try {
    writeFileSync(
      tmpFile,
      `${JSON.stringify(Object.fromEntries(learned), null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(tmpFile, file);
  } catch (err) {
    console.warn(`[projects] couldn't save ${file}: ${(err as Error).message}`);
  }
}

// ── git (off the request path) ──────────────────────────────────

const negative = new Map<string, number>(); // dir → when it was found not-git
const inflight = new Set<string>();
const queue: string[] = [];
let running = 0;

/** The environment for a git lookup: never prompt, take no optional locks,
 *  and DROP the variables that redirect git elsewhere — a server started
 *  under a git hook (or anything exporting GIT_DIR) would otherwise have
 *  `git -C <dir>` describe THAT repo and misfile every session into it. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const k of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_CEILING_DIRECTORIES",
  ])
    delete env[k];
  return env;
}

function gitCommonDir(dir: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        // Never prompt, never touch the network, ignore a hostile config's
        // fsmonitor: this is a read of local metadata only.
        env: gitEnv(),
      },
      (err, out) => resolve(err ? null : out.trim() || null),
    );
  });
}

/** The repo root for a `--git-common-dir`: `<root>/.git` → `<root>`; a bare
 *  repo's common dir IS the repo. */
export function repoRootFromCommonDir(common: string): string {
  return basename(common) === ".git" ? dirname(common) : common;
}

function pump(): void {
  while (running < GIT_CONCURRENCY && queue.length > 0) {
    const dir = queue.shift() as string;
    running++;
    void gitCommonDir(dir)
      .then((common) => {
        if (common) {
          const map = loadLearned();
          const root = repoRootFromCommonDir(common);
          if (map.get(dir) !== root) {
            map.set(dir, root);
            scheduleSave();
          }
        } else {
          negative.set(dir, Date.now());
        }
      })
      .finally(() => {
        running--;
        inflight.delete(dir);
        pump();
      });
  }
}

/** Queue an existing dir for git resolution (no-op if known or queued). */
function enqueue(dir: string): void {
  if (inflight.has(dir) || loadLearned().has(dir)) return;
  const neg = negative.get(dir);
  if (neg !== undefined && Date.now() - neg < NEGATIVE_TTL_MS) return;
  inflight.add(dir);
  queue.push(dir);
  pump();
}

// ── resolve (cache-only; never blocks) ──────────────────────────

const WORKTREES_ROOT = join(homedir(), ".claude-worktrees");

/**
 * The project for `dir`, from what's known NOW. Existing dirs not yet resolved
 * are queued for git in the background and read as "dir" until then.
 */
let tempCheck: (dir: string) => boolean = (dir) => isTempDir(dir);

export function resolveDir(dir: string, exists: boolean): DirResolution {
  if (tempCheck(dir)) return { kind: "temp" };
  const map = loadLearned();
  const known = map.get(dir);
  if (known)
    return {
      kind: "repo",
      repoRoot: known,
      resolvedBy: exists ? "git" : "learned",
    };
  if (exists) {
    enqueue(dir);
    return { kind: "dir" };
  }
  // Deleted before we ever saw it: the worktree-manager naming convention.
  const guess = conventionRepo(dir, map);
  if (guess) return { kind: "repo", repoRoot: guess, resolvedBy: "convention" };
  return { kind: "dir" };
}

/** `~/.claude-worktrees/<repo>-<branch>` → the known repo root whose basename
 *  is the longest `<repo>-` prefix of the worktree's name. */
export function conventionRepo(
  dir: string,
  map: ReadonlyMap<string, string>,
  worktreesRoot = WORKTREES_ROOT,
): string | undefined {
  if (dirname(dir) !== worktreesRoot) return undefined;
  const name = basename(dir);
  let best: string | undefined;
  for (const root of new Set(map.values())) {
    const repo = basename(root);
    if (
      name.startsWith(`${repo}-`) &&
      (!best || repo.length > basename(best).length)
    )
      best = root;
  }
  return best;
}

/** For tests: reset every cache and point persistence at the config dir anew. */
export function _resetProjectResolverForTesting(): void {
  learned = undefined;
  learnedDirty = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = undefined;
  negative.clear();
  inflight.clear();
  queue.length = 0;
}

/** For tests: resolves once every queued git lookup has finished. */
export async function _drainProjectResolverForTesting(): Promise<void> {
  while (running > 0 || queue.length > 0)
    await new Promise((r) => setTimeout(r, 10));
}

/** For tests: treat only paths this predicate accepts as temp (the real
 *  check classifies every tmpdir() path as temp, where test repos live). */
export function _setTempCheckForTesting(
  check: ((dir: string) => boolean) | null,
): void {
  tempCheck = check ?? ((dir) => isTempDir(dir));
}

/** For tests: write the learned map now instead of after the debounce. */
export function _flushProjectResolverForTesting(): void {
  saveNow();
}

/** For tests: seed the learned map (as if git had resolved these earlier). */
export function _learnForTesting(dir: string, root: string): void {
  loadLearned().set(dir, root);
}
