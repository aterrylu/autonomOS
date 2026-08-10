// Source-mode upgrade backend (ADR-077 §3) — a MANAGED CLONE pinned to
// release tags. The bundle backend's atomic-rename swap has no analogue
// here; git IS the version store:
//
//   fetch tags → refuse on a dirty tree → record HEAD for rollback →
//   checkout the target tag → rebuild → caller restarts + health-gates
//
// Two rules carried over from the incident history that produced this mode:
//   - DIRTY TREE REFUSES. An uncommitted revert on a live box once had the
//     daemon running code no commit explained. "Agents can modify the
//     platform" means patch-and-commit, never update-over-uncommitted-work.
//   - TAGS, not branch tips. `git pull main` deploys whatever the branch
//     holds at that second; a tag is a version with a name, comparable,
//     pinnable, and rollback-able.
//
// Rollback is previousRef in install.json — one cycle deep, the source
// analogue of bundle mode's `.previous` directory, symmetric the same way.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type InstallInfo, writeInstallJson } from "./installInfo.js";
import { compareSemver } from "./upgrade.js";

export type SourceUpgradeOptions = {
  /** The managed clone's repo root (install.json's prefix in source mode). */
  repoRoot: string;
  /** The marker as resolved — rewritten with rollback fields on success. */
  installInfo: InstallInfo;
  /** Current installed version (the checkout's package.json). */
  currentVersion: string;
  /** Pin a version (no leading v). Skips the newer-than guard, like bundle mode. */
  targetVersion?: string;
  /**
   * Build command run in repoRoot after checkout. Default: `make build`
   * (deps + channel-server + dashboard, no service operations). Injectable
   * for tests — a real checkout rebuild takes minutes.
   */
  buildCommand?: readonly string[];
};

export type SourceUpgradeResult =
  | { status: "up-to-date"; version: string }
  | {
      status: "upgraded";
      from: string;
      to: string;
      direction: "upgrade" | "downgrade";
    }
  | { status: "error"; message: string };

const DEFAULT_BUILD_COMMAND = ["make", "build"] as const;

/**
 * Env for spawned git: the inherited environment MINUS git's own context
 * vars. Inside a git hook (pre-push runs this code path via the test suite;
 * a user could also run `autonomos upgrade` from a hook or alias) GIT_DIR /
 * GIT_WORK_TREE / GIT_INDEX_FILE are exported — an inherited GIT_DIR makes
 * every spawned git operate on the OUTER repository regardless of cwd.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "GIT_DIR" ||
      key === "GIT_WORK_TREE" ||
      key === "GIT_INDEX_FILE" ||
      key === "GIT_COMMON_DIR" ||
      key === "GIT_PREFIX"
    ) {
      delete env[key];
    }
  }
  return env;
}

/** Run git in the repo root; returns stdout or null on failure. */
function git(repoRoot: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    env: gitEnv(),
  });
  if (result.status !== 0) return null;
  return result.stdout.trimEnd();
}

/** Like git(), but failure carries stderr for the error message. */
function gitOrError(
  repoRoot: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; message: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    env: gitEnv(),
  });
  if (result.status !== 0) {
    return {
      ok: false,
      message:
        result.stderr?.trim() ||
        result.error?.message ||
        `git ${args[0]} exited ${result.status}`,
    };
  }
  return { ok: true, stdout: result.stdout.trimEnd() };
}

/**
 * TRACKED files that `make build` regenerates in place. A byte-difference
 * from the committed artifact (esbuild version drift, lockfile re-resolve)
 * would otherwise leave the tree dirty after every successful build — so the
 * NEXT upgrade/rollback would hit the dirty-tree refusal forever, defeated
 * by the updater's own build step. These are restored to the committed state
 * before the dirty check (they are regenerable by definition; anything ELSE
 * modified still refuses), and the post-checkout build regenerates them.
 */
export const BUILD_MUTATED_TRACKED_FILES = [
  "packages/server/src/channel-server/dist.mjs",
  "bun.lock",
] as const;

/**
 * Restore the build-regenerated tracked artifacts to their committed state.
 * Per-path and failure-tolerant: a path may not exist in the current
 * revision (older tags), which is fine — the dirty check right after is the
 * arbiter of what remains.
 */
export function resetBuildArtifacts(repoRoot: string): void {
  for (const path of BUILD_MUTATED_TRACKED_FILES) {
    git(repoRoot, ["checkout", "--", path]);
  }
}

/**
 * Tracked modifications block an upgrade; untracked files don't (build
 * output and .env legitimately sit untracked in a deployment clone — and
 * everything ignored never shows in porcelain at all).
 */
export function dirtyTrackedFiles(repoRoot: string): string[] | null {
  const out = git(repoRoot, ["status", "--porcelain"]);
  if (out === null) return null;
  return out
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("??"))
    .map((line) => line.slice(3));
}

/**
 * Highest semver v* tag known locally (call after a fetch). A git execution
 * failure is distinguished from "no tags" — conflating them made the caller
 * report "No release tags found" for what could be a broken git.
 */
export function latestVersionTag(
  repoRoot: string,
): { ok: true; version: string | null } | { ok: false; message: string } {
  const result = gitOrError(repoRoot, ["tag", "--list", "v*"]);
  if (!result.ok) return result;
  const versions = result.stdout
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1))
    .sort(compareSemver);
  return { ok: true, version: versions[versions.length - 1] ?? null };
}

export async function performSourceUpgrade(
  opts: SourceUpgradeOptions,
): Promise<SourceUpgradeResult> {
  const { repoRoot } = opts;

  if (!existsSync(join(repoRoot, ".git"))) {
    return {
      status: "error",
      message:
        `${repoRoot} is marked as a source install but is not a git clone ` +
        `(.git missing). Re-create it with scripts/install-source.sh.`,
    };
  }
  if (opts.currentVersion === "unknown") {
    return {
      status: "error",
      message:
        "Cannot determine the installed version (package.json missing or " +
        "unreadable in the checkout). Repair the clone before upgrading.",
    };
  }

  // Build-regenerated tracked artifacts are restored first — without this,
  // the tree is dirty after every successful build and this refusal would
  // fire on every subsequent run.
  resetBuildArtifacts(repoRoot);
  const dirty = dirtyTrackedFiles(repoRoot);
  if (dirty === null) {
    return { status: "error", message: "git status failed in the clone." };
  }
  if (dirty.length > 0) {
    return {
      status: "error",
      message:
        `The managed clone has uncommitted changes to tracked files — ` +
        `refusing to update over them:\n  ${dirty.join("\n  ")}\n` +
        `Commit, stash, or discard them, then re-run.`,
    };
  }

  const fetch = gitOrError(repoRoot, ["fetch", "--tags", "origin"]);
  if (!fetch.ok) {
    return {
      status: "error",
      message: `git fetch --tags failed: ${fetch.message}`,
    };
  }

  let targetVersion = opts.targetVersion;
  if (!targetVersion) {
    const latest = latestVersionTag(repoRoot);
    if (!latest.ok) {
      return {
        status: "error",
        message: `git tag listing failed: ${latest.message}`,
      };
    }
    if (!latest.version) {
      return {
        status: "error",
        message: "No release tags (vX.Y.Z) found in the clone after fetch.",
      };
    }
    targetVersion = latest.version;
  } else if (
    !git(repoRoot, ["rev-parse", "--verify", `refs/tags/v${targetVersion}`])
  ) {
    return {
      status: "error",
      message: `No release tag v${targetVersion} exists in the repository.`,
    };
  }

  // Same guard semantics as bundle mode: equal is a no-op; ahead without an
  // explicit pin is a no-op (never silently downgrade a dev/beta build); a
  // pin means the named version, downgrades included.
  const cmp = compareSemver(opts.currentVersion, targetVersion);
  if (cmp === 0 || (cmp > 0 && !opts.targetVersion)) {
    return { status: "up-to-date", version: targetVersion };
  }

  const previousRef = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!previousRef) {
    return { status: "error", message: "git rev-parse HEAD failed." };
  }

  const checkout = gitOrError(repoRoot, ["checkout", `v${targetVersion}`]);
  if (!checkout.ok) {
    return {
      status: "error",
      message: `git checkout v${targetVersion} failed: ${checkout.message}`,
    };
  }

  const build = runBuild(repoRoot, opts.buildCommand);
  if (!build.ok) {
    // A failed build must not leave the clone on a tag it can't serve — go
    // back to the ref that was running, AND REBUILD THERE: the failed build
    // may already have destroyed gitignored artifacts (make build rm -rf's
    // _embedded_dashboard before vite regenerates it), and a git checkout
    // restores only tracked files. Without the rebuild, "returned to the
    // previous commit" would be true of the source and false of the
    // artifacts — the next daemon respawn would serve a clone with no
    // dashboard build.
    const revert = gitOrError(repoRoot, ["checkout", previousRef]);
    if (!revert.ok) {
      return {
        status: "error",
        message:
          `Build failed after checking out v${targetVersion}: ${build.message}\n` +
          `AND returning to the previous commit failed — the clone is at ` +
          `v${targetVersion} unbuilt. Recover with: git checkout ${previousRef} && make build`,
      };
    }
    const revertBuild = runBuild(repoRoot, opts.buildCommand);
    return {
      status: "error",
      message:
        `Build failed after checking out v${targetVersion}: ${build.message}\n` +
        (revertBuild.ok
          ? `The clone was returned to its previous commit (${previousRef.slice(0, 12)}) ` +
            `and rebuilt there; the running daemon was never touched.`
          : `The clone was returned to its previous commit (${previousRef.slice(0, 12)}), ` +
            `but REBUILDING there also failed (${revertBuild.message}) — build ` +
            `artifacts (e.g. the dashboard bundle) may be missing until ` +
            `\`make build\` succeeds. The running daemon keeps serving from ` +
            `memory, but do not restart it until the build is repaired.`),
    };
  }

  // Marker rewrite AFTER the build succeeds: previousRef is what rollback
  // returns to, and it must only ever point at a state that was serving.
  // Guarded: a throw here (ENOSPC, EACCES) would escape as a raw stack while
  // leaving the clone checked out+built at the NEW tag with the OLD cycle's
  // rollback state — a later rollback would target a commit from two cycles
  // ago. Report the exact state and recovery instead.
  try {
    writeInstallJson(repoRoot, {
      ...opts.installInfo,
      installedBy: "upgrade",
      installedAt: new Date().toISOString(),
      previousRef,
      previousVersion: opts.currentVersion,
    });
  } catch (err) {
    return {
      status: "error",
      message:
        `Upgrade is checked out and built at v${targetVersion}, but writing ` +
        `install.json failed (${err instanceof Error ? err.message : err}). ` +
        `The daemon was NOT restarted and rollback state was NOT recorded.\n` +
        `Fix the write (disk space / permissions on ${repoRoot}), then either ` +
        `re-run \`autonomos upgrade\` or restart manually — the pre-upgrade ` +
        `commit was ${previousRef.slice(0, 12)}.`,
    };
  }

  return {
    status: "upgraded",
    from: opts.currentVersion,
    to: getVersionAt(repoRoot) ?? targetVersion,
    direction: cmp > 0 ? "downgrade" : "upgrade",
  };
}

export type SourceRollbackResult =
  | { status: "rolled-back"; from: string; to: string }
  | { status: "error"; message: string };

export function performSourceRollback(
  repoRoot: string,
  installInfo: InstallInfo,
  buildCommand?: readonly string[],
): SourceRollbackResult {
  const { previousRef } = installInfo;
  if (!previousRef) {
    return {
      status: "error",
      message:
        "No previous checkout recorded in install.json — only the state " +
        "displaced by the most recent source-mode upgrade can be rolled back to.",
    };
  }
  if (!existsSync(join(repoRoot, ".git"))) {
    return {
      status: "error",
      message:
        `${repoRoot} is marked as a source install but is not a git clone ` +
        `(.git missing). Re-create it with scripts/install-source.sh.`,
    };
  }

  // Build-regenerated tracked artifacts are restored first — without this,
  // the tree is dirty after every successful build and this refusal would
  // fire on every subsequent run.
  resetBuildArtifacts(repoRoot);
  const dirty = dirtyTrackedFiles(repoRoot);
  if (dirty === null) {
    return { status: "error", message: "git status failed in the clone." };
  }
  if (dirty.length > 0) {
    return {
      status: "error",
      message:
        `The managed clone has uncommitted changes to tracked files — ` +
        `refusing to roll back over them:\n  ${dirty.join("\n  ")}`,
    };
  }

  const from = getVersionAt(repoRoot) ?? "unknown";
  const currentRef = git(repoRoot, ["rev-parse", "HEAD"]);
  if (!currentRef) {
    return { status: "error", message: "git rev-parse HEAD failed." };
  }

  const checkout = gitOrError(repoRoot, ["checkout", previousRef]);
  if (!checkout.ok) {
    return {
      status: "error",
      message: `git checkout ${previousRef} failed: ${checkout.message}`,
    };
  }

  const build = runBuild(repoRoot, buildCommand);
  if (!build.ok) {
    return {
      status: "error",
      message:
        `Build failed on the rolled-back commit: ${build.message}\n` +
        `The clone is at ${previousRef.slice(0, 12)}. Roll forward with: ` +
        `git checkout ${currentRef} && make build`,
    };
  }

  const to = getVersionAt(repoRoot) ?? "unknown";
  // Symmetric, like bundle mode: the displaced state becomes the new
  // "previous", so running rollback twice returns to where you started.
  // Guarded for the same reason as the upgrade flow's marker write.
  try {
    writeInstallJson(repoRoot, {
      ...installInfo,
      installedBy: "rollback",
      installedAt: new Date().toISOString(),
      previousRef: currentRef,
      previousVersion: from,
    });
  } catch (err) {
    return {
      status: "error",
      message:
        `Rolled back and rebuilt at ${previousRef.slice(0, 12)}, but writing ` +
        `install.json failed (${err instanceof Error ? err.message : err}) — ` +
        `roll-forward state was NOT recorded. Fix the write (disk space / ` +
        `permissions on ${repoRoot}); the displaced commit was ${currentRef.slice(0, 12)}.`,
    };
  }

  return { status: "rolled-back", from, to };
}

function runBuild(
  repoRoot: string,
  buildCommand: readonly string[] | undefined,
): { ok: true } | { ok: false; message: string } {
  const [cmd, ...args] = buildCommand ?? DEFAULT_BUILD_COMMAND;
  if (!cmd) return { ok: false, message: "empty build command" };
  const result = spawnSync(cmd, args, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    return {
      ok: false,
      message: result.error?.message ?? `${cmd} exited ${result.status}`,
    };
  }
  return { ok: true };
}

/**
 * The version the checkout currently carries. Read explicitly from repoRoot
 * (not via getServerVersion, which resolves relative to the RUNNING module —
 * mid-upgrade those can differ: the process runs pre-checkout code while the
 * tree already holds the new version).
 */
export function getVersionAt(repoRoot: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "packages/server/package.json"), "utf-8"),
    ) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
