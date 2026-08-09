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

/** Highest semver v* tag known locally (call after a fetch). */
export function latestVersionTag(repoRoot: string): string | null {
  const out = git(repoRoot, ["tag", "--list", "v*"]);
  if (!out) return null;
  const versions = out
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1))
    .sort(compareSemver);
  return versions[versions.length - 1] ?? null;
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

  const targetVersion = opts.targetVersion ?? latestVersionTag(repoRoot);
  if (!targetVersion) {
    return {
      status: "error",
      message: "No release tags (vX.Y.Z) found in the clone after fetch.",
    };
  }
  if (
    opts.targetVersion &&
    !git(repoRoot, ["rev-parse", `v${targetVersion}`])
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
    // A failed build must not leave the clone on a tag it can't serve —
    // go back to the ref that was running.
    const revert = gitOrError(repoRoot, ["checkout", previousRef]);
    return {
      status: "error",
      message:
        `Build failed after checking out v${targetVersion}: ${build.message}\n` +
        (revert.ok
          ? `The clone was returned to its previous commit (${previousRef.slice(0, 12)}); ` +
            `the running daemon was never touched.`
          : `AND returning to the previous commit failed — the clone is at ` +
            `v${targetVersion} unbuilt. Recover with: git checkout ${previousRef} && make build`),
    };
  }

  // Marker rewrite AFTER the build succeeds: previousRef is what rollback
  // returns to, and it must only ever point at a state that was serving.
  writeInstallJson(repoRoot, {
    ...opts.installInfo,
    installedBy: "upgrade",
    installedAt: new Date().toISOString(),
    previousRef,
    previousVersion: opts.currentVersion,
  });

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
  writeInstallJson(repoRoot, {
    ...installInfo,
    installedBy: "rollback",
    installedAt: new Date().toISOString(),
    previousRef: currentRef,
    previousVersion: from,
  });

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
