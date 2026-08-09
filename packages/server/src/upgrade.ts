// Shared upgrade logic (ADR-072). Used by both:
//   - The CLI `autonomos upgrade` command (runs out-of-process, can upgrade
//     even when the daemon is stopped, owns the post-restart health gate)
//   - The server POST /api/system/upgrade endpoint (runs in-process; performs
//     the swap then stage-then-exit(0)s so the supervisor revives it — the
//     process is never the agent of its own restart)
//
// The flow:
//   1. Caller resolves the install via installInfo.resolveInstall() — the
//      recorded marker decides the backend, never a path sniff
//   2. Query GitHub Releases for the latest tag (or a pinned --version tag)
//   3. If same version, return up-to-date
//   4. Download tarball + SHA256SUMS to a staging directory
//   5. Verify the tarball's SHA256
//   6. Extract into a sibling "new" directory next to the live bundle and
//      write install.json into it (the marker travels with the swap)
//   7. Atomic swap: rename live → previous, rename new → live
//   8. Return — caller restarts the daemon IMMEDIATELY (a live Node process
//      must not keep lazily require()ing against a swapped directory)
//
// .previous is kept until the next upgrade overwrites it. `autonomos rollback`
// (performRollback) swaps it back; the same command run again swaps forward.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InstallInfo, writeInstallJson } from "./installInfo.js";

const DEFAULT_RELEASE_REPO = "aterrylu/autonomOS";
const DEFAULT_RELEASE_API_BASE = "https://api.github.com";

export type Platform =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64";

export type UpgradeOptions = {
  /**
   * Path to the live bundle directory — typically `$PREFIX/share/autonomos`.
   * The tarball is extracted into a sibling `.new` directory, then renamed
   * atomically over this.
   */
  bundleDir: string;
  /** Current installed version string. Compared against the release tag. */
  currentVersion: string;
  platform: Platform;
  /**
   * Install marker to write into the new bundle before the swap, so the
   * install shape stays recorded across upgrades (including legacy installs
   * that predate the marker — their first upgrade writes it).
   */
  installInfo: InstallInfo;
  /**
   * Pin a specific version (no leading "v"). Skips the newer-than guard —
   * naming a version IS the intent, including a downgrade. Default: latest.
   */
  targetVersion?: string;
  /** Override the upstream repo (used by tests). Default "aterrylu/autonomOS". */
  releaseRepo?: string;
  /**
   * Override the release API base URL (used by tests / hermetic installs to
   * point at a local fixture server). Default "https://api.github.com".
   */
  releaseApiBase?: string;
};

export type UpgradeResult =
  | { status: "up-to-date"; version: string }
  | {
      status: "upgraded";
      from: string;
      to: string;
      direction: "upgrade" | "downgrade";
    }
  | { status: "error"; message: string };

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name: string;
  assets: GitHubReleaseAsset[];
};

export function detectPlatform(): Platform {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "darwin" && arch === "arm64") return "darwin-arm64";
  if (plat === "darwin" && arch === "x64") return "darwin-x64";
  if (plat === "linux" && arch === "x64") return "linux-x64";
  if (plat === "linux" && arch === "arm64") return "linux-arm64";
  throw new Error(`Unsupported platform: ${plat}/${arch}`);
}

export async function performUpgrade(
  opts: UpgradeOptions,
): Promise<UpgradeResult> {
  const repo = opts.releaseRepo ?? DEFAULT_RELEASE_REPO;
  const apiBase = opts.releaseApiBase ?? DEFAULT_RELEASE_API_BASE;

  // A missing/corrupt version file reads as "unknown", which parses as 0.0.0
  // and would sail through the semver gate — every display already degraded,
  // and a silent "upgrade" would mask the corruption. Refuse loudly instead.
  if (opts.currentVersion === "unknown") {
    return {
      status: "error",
      message:
        "Cannot determine the installed version (package.json missing or " +
        "unreadable in the bundle). Re-install with the install script " +
        "before upgrading.",
    };
  }

  const apiUrl = opts.targetVersion
    ? `${apiBase}/repos/${repo}/releases/tags/v${opts.targetVersion}`
    : `${apiBase}/repos/${repo}/releases/latest`;

  // ── fetch release metadata
  let release: GitHubRelease;
  try {
    const resp = await fetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) {
      const detail =
        resp.status === 404 && opts.targetVersion
          ? `No release tagged v${opts.targetVersion} exists`
          : `GitHub API returned ${resp.status}: ${await resp.text()}`;
      return { status: "error", message: detail };
    }
    release = (await resp.json()) as GitHubRelease;
  } catch (err) {
    return {
      status: "error",
      message: `Failed to fetch release info: ${err instanceof Error ? err.message : err}`,
    };
  }

  const releaseVersion = release.tag_name.replace(/^v/, "");
  // Same version is always a no-op. So is being AHEAD of the release (manual
  // install / dev build / beta newer than `latest`) — refusing only on
  // equality would silently downgrade those. A pin overrides the ahead-guard:
  // naming a version IS the intent, downgrades included, and the caller is
  // responsible for saying so out loud.
  const cmp = compareSemver(opts.currentVersion, releaseVersion);
  if (cmp === 0 || (cmp > 0 && !opts.targetVersion)) {
    return { status: "up-to-date", version: releaseVersion };
  }

  // ── find the matching asset for this platform
  const tarballName = `autonomos-${opts.platform}.tar.gz`;
  const tarball = release.assets.find((a) => a.name === tarballName);
  const sha256sums = release.assets.find((a) => a.name === "SHA256SUMS");
  if (!tarball || !sha256sums) {
    return {
      status: "error",
      message: `Release ${release.tag_name} is missing ${tarballName} or SHA256SUMS`,
    };
  }

  // ── download both into a staging dir
  // mkdtemp, not a pid-derived name: a predictable path in world-writable
  // /tmp lets a local attacker pre-plant a symlink or win the window between
  // checksum and extraction — the tarball staged here becomes the running
  // server.
  const staging = mkdtempSync(join(tmpdir(), "autonomos-upgrade-"));

  try {
    const tarballPath = join(staging, tarballName);
    const sha256sumsPath = join(staging, "SHA256SUMS");

    await downloadTo(tarball.browser_download_url, tarballPath);
    await downloadTo(sha256sums.browser_download_url, sha256sumsPath);

    // ── verify checksum
    const sums = readFileSync(sha256sumsPath, "utf-8");
    const expected = sums
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .find(([, name]) => name === tarballName)?.[0];
    if (!expected) {
      return {
        status: "error",
        message: `SHA256SUMS does not list ${tarballName}`,
      };
    }
    const actual = computeSha256(tarballPath);
    if (actual !== expected) {
      return {
        status: "error",
        message: `Checksum mismatch for ${tarballName}: expected ${expected}, got ${actual}`,
      };
    }

    // ── extract into a sibling directory
    const newDir = `${opts.bundleDir}.new`;
    const previousDir = `${opts.bundleDir}.previous`;
    rmSync(newDir, { recursive: true, force: true });
    mkdirSync(newDir, { recursive: true });
    const tarResult = spawnSync("tar", ["-xzf", tarballPath, "-C", newDir], {
      encoding: "utf-8",
    });
    if (tarResult.status !== 0) {
      return {
        status: "error",
        // tar missing from PATH surfaces as status:null + error set, stderr
        // empty — don't report that as "failed: null".
        message: `tar extraction failed: ${
          tarResult.stderr?.trim() ||
          tarResult.error?.message ||
          `exit status ${tarResult.status}`
        }`,
      };
    }

    // The marker travels with the swap — the new bundle must describe itself.
    writeInstallJson(newDir, {
      ...opts.installInfo,
      installedBy: "upgrade",
      installedAt: new Date().toISOString(),
    });

    // ── atomic swap (current → previous, new → current)
    rmSync(previousDir, { recursive: true, force: true });
    const liveDisplaced = existsSync(opts.bundleDir);
    if (liveDisplaced) {
      renameSync(opts.bundleDir, previousDir);
    }
    try {
      renameSync(newDir, opts.bundleDir);
    } catch (err) {
      // The one state that must never persist: live renamed away, new not in
      // place — NOTHING at the live path, which bricks the wrapper (it execs
      // a file inside that dir) and with it every recovery command. Put the
      // displaced bundle back before reporting.
      let restored = false;
      if (liveDisplaced) {
        try {
          renameSync(previousDir, opts.bundleDir);
          restored = true;
        } catch {
          // fall through to the honest message below
        }
      }
      const detail = err instanceof Error ? err.message : String(err);
      return {
        status: "error",
        message: restored
          ? `Failed to move the new bundle into place (${detail}). ` +
            `The previous version was restored and is still live.`
          : `Failed to move the new bundle into place (${detail}) AND the ` +
            `previous version could not be restored. Recover manually:\n` +
            `  mv ${previousDir} ${opts.bundleDir}\n` +
            `(the downloaded new version is at ${newDir})`,
      };
    }

    return {
      status: "upgraded",
      from: opts.currentVersion,
      to: releaseVersion,
      direction: cmp > 0 ? "downgrade" : "upgrade",
    };
  } catch (err) {
    // Anything thrown above (asset download, fs errors) must honor the
    // UpgradeResult contract — a raw throw reaches the CLI as a stack trace
    // and the REST route as a bare 500. Every throwing step precedes the
    // swap (whose own failure is handled inline above), so the live bundle
    // is untouched here.
    return {
      status: "error",
      message: `Upgrade failed: ${err instanceof Error ? err.message : err}`,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export type RollbackResult =
  | { status: "rolled-back"; from: string; to: string }
  | { status: "error"; message: string };

/**
 * Swap the live bundle with `.previous`. Symmetric: running it twice returns
 * to where you started (the displaced live dir becomes the new `.previous`).
 * The caller restarts the daemon immediately after — same rule as upgrade.
 */
export function performRollback(bundleDir: string): RollbackResult {
  const previousDir = `${bundleDir}.previous`;
  if (!existsSync(previousDir)) {
    return {
      status: "error",
      message:
        `No previous version to roll back to (${previousDir} not found). ` +
        "Only the version displaced by the most recent upgrade is kept.",
    };
  }
  const from = readBundleVersion(bundleDir);
  const to = readBundleVersion(previousDir);

  // Three-rename swap through a temp name so a crash at any point leaves
  // both bundles on disk under recoverable names.
  const tempDir = `${bundleDir}.rollback-tmp`;
  try {
    if (existsSync(bundleDir)) {
      // Clear a leftover tempDir only when a live dir is about to replace it.
      // After a crash mid-rollback the tempDir IS the displaced live copy
      // (and bundleDir is absent) — deleting it then would destroy one of the
      // two bundles this function exists to preserve.
      rmSync(tempDir, { recursive: true, force: true });
      renameSync(bundleDir, tempDir);
    }
    renameSync(previousDir, bundleDir);
    if (existsSync(tempDir)) {
      renameSync(tempDir, previousDir);
    }
  } catch (err) {
    // A throw here must not escape: the caller prints recovery guidance off
    // this message, and an unhandled throw would skip it (leaving a possibly
    // bundle-less install with only a stack trace).
    const state = [
      existsSync(bundleDir) ? `live: ${bundleDir}` : "live: MISSING",
      existsSync(previousDir) ? `previous: ${previousDir}` : null,
      existsSync(tempDir) ? `displaced copy: ${tempDir}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return {
      status: "error",
      message:
        `Rollback failed mid-swap (${err instanceof Error ? err.message : err}). ` +
        `Current state — ${state}. If live is missing, restore it with ` +
        `\`mv ${existsSync(previousDir) ? previousDir : tempDir} ${bundleDir}\`.`,
    };
  }

  return { status: "rolled-back", from, to };
}

/** Version stamped into a bundle dir's package.json, or "unknown". */
export function readBundleVersion(bundleDir: string): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(bundleDir, "package.json"), "utf-8"),
    ) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Compare two semver-ish version strings (e.g. "0.0.10" vs "0.0.9"). Returns
 * 1 if a > b, -1 if a < b, 0 if equal. Pre-release suffixes are ignored.
 * Designed to be tiny — we only need numeric "x.y.z" comparison for the
 * upgrade flow's downgrade-guard. Exported for tests.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string): number[] =>
    s
      .replace(/-.*$/, "")
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const av = aa[i] ?? 0;
    const bv = bb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed (${resp.status}) for ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(dest, buf);
}

function computeSha256(path: string): string {
  // node:crypto for portability — shasum may not be available on every host.
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}
