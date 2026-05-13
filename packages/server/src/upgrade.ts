// Shared upgrade logic. Used by both:
//   - The CLI `autonomos upgrade` command (runs out-of-process, can upgrade
//     even when the daemon is stopped)
//   - The server POST /api/system/upgrade endpoint (runs in-process; daemon
//     self-restarts after the swap)
//
// The flow:
//   1. Read current install layout (bundle dir, current version)
//   2. Query GitHub Releases for the latest tag + matching tarball
//   3. If same version, return up-to-date
//   4. Download tarball + SHA256SUMS to a staging directory
//   5. Verify the tarball's SHA256
//   6. Extract into a sibling "new" directory next to the live bundle
//   7. Atomic swap: rename live → previous, rename new → live
//   8. Return — caller is responsible for restarting the daemon
//
// We deliberately keep .previous around for one upgrade cycle so a user with
// a broken upgrade can roll back manually:  mv share/autonomos.previous → share/autonomos.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as pathResolve } from "node:path";

const DEFAULT_RELEASE_REPO = "aterrylu/autonomOS";

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
  /** Override the upstream repo (used by tests). Default "aterrylu/autonomOS". */
  releaseRepo?: string;
};

export type UpgradeResult =
  | { status: "up-to-date"; version: string }
  | { status: "upgraded"; from: string; to: string }
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

/**
 * Derive the install prefix from process.argv[1]. Assumes the wrapper invoked
 * us — i.e., we're running `node $PREFIX/share/autonomos/index.js`. Returns
 * the parent directory of `share/`. Throws if the layout doesn't match
 * (e.g., when running from a worktree via tsx).
 */
export function deriveBundleDir(): string {
  const script = process.argv[1];
  if (!script) throw new Error("process.argv[1] is missing");
  const dir = pathResolve(script, "..");
  // Expected layout: <prefix>/share/autonomos/index.js
  if (!dir.endsWith("/share/autonomos") && !dir.endsWith("/share/autonomos/")) {
    throw new Error(
      `Cannot determine install location from script path: ${script}\n` +
        `Expected layout: <prefix>/share/autonomos/index.js. ` +
        `If you're running from a dev checkout, 'autonomos upgrade' is not supported there.`,
    );
  }
  return dir;
}

export async function performUpgrade(
  opts: UpgradeOptions,
): Promise<UpgradeResult> {
  const repo = opts.releaseRepo ?? DEFAULT_RELEASE_REPO;
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;

  // ── fetch release metadata
  let release: GitHubRelease;
  try {
    const resp = await fetch(apiUrl, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!resp.ok) {
      return {
        status: "error",
        message: `GitHub API returned ${resp.status}: ${await resp.text()}`,
      };
    }
    release = (await resp.json()) as GitHubRelease;
  } catch (err) {
    return {
      status: "error",
      message: `Failed to fetch release info: ${err instanceof Error ? err.message : err}`,
    };
  }

  const latestVersion = release.tag_name.replace(/^v/, "");
  if (latestVersion === opts.currentVersion) {
    return { status: "up-to-date", version: latestVersion };
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
  const staging = join(tmpdir(), `autonomos-upgrade-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

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
        message: `tar extraction failed: ${tarResult.stderr}`,
      };
    }

    // ── atomic swap (current → previous, new → current)
    rmSync(previousDir, { recursive: true, force: true });
    if (existsSync(opts.bundleDir)) {
      renameSync(opts.bundleDir, previousDir);
    }
    renameSync(newDir, opts.bundleDir);

    return {
      status: "upgraded",
      from: opts.currentVersion,
      to: latestVersion,
    };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed (${resp.status}) for ${url}`);
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const { writeFileSync } = await import("node:fs");
  writeFileSync(dest, buf);
}

function computeSha256(path: string): string {
  // node:crypto for portability — shasum may not be available on every host.
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}
