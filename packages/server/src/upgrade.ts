// Shared upgrade logic (ADR-077). Used by the CLI `autonomos upgrade`
// command (runs out-of-process, can upgrade even when the daemon is stopped,
// owns the post-restart health gate) — both from a shell and as the in-app
// update's out-of-band job (ADR-105: POST /api/system/upgrade launches that
// command in its own supervisor scope; nothing here runs inside the daemon).
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
import {
  type ProvenanceResult,
  verifyReleaseProvenance,
} from "./provenance.js";

export const DEFAULT_RELEASE_REPO = "aterrylu/autonomOS";
export const DEFAULT_RELEASE_API_BASE = "https://api.github.com";

export type ReleaseOverrides =
  | { releaseApiBase: string | undefined; releaseRepo: string | undefined }
  | { error: string };

/**
 * The release-source env overrides exist for the hermetic test harness, but
 * they are production-reachable — and whoever controls the API base controls
 * BOTH the tarball and its SHA256SUMS, so the checksum cannot protect
 * against a redirected source (nothing is signed). A var planted in a shell
 * rc converts the user's own later `autonomos upgrade` into running
 * attacker code. So: warn loudly whenever one is set, and refuse a
 * non-HTTPS base unless it points at loopback (the fixture case).
 *
 * SHARED by the CLI upgrade command and the server's passive update check —
 * both must resolve the same source with the same guard rails, or a
 * redirected box's badge and CLI would disagree about "latest".
 */
export function resolveReleaseOverrides(): ReleaseOverrides {
  const releaseApiBase = process.env.AUTONOMOS_RELEASE_API_URL;
  const releaseRepo = process.env.AUTONOMOS_RELEASE_REPO;
  if (releaseApiBase || releaseRepo) {
    console.warn("⚠️  Release source is overridden by environment variables:");
    if (releaseApiBase) {
      console.warn(`   AUTONOMOS_RELEASE_API_URL=${releaseApiBase}`);
    }
    if (releaseRepo) {
      console.warn(`   AUTONOMOS_RELEASE_REPO=${releaseRepo}`);
    }
    console.warn("   (unset these unless you set them yourself, on purpose)");
  }
  if (releaseApiBase) {
    let url: URL;
    try {
      url = new URL(releaseApiBase);
    } catch {
      return {
        error: `AUTONOMOS_RELEASE_API_URL is not a valid URL: ${releaseApiBase}`,
      };
    }
    const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(
      url.hostname,
    );
    if (url.protocol !== "https:" && !loopback) {
      return {
        error:
          `AUTONOMOS_RELEASE_API_URL must be https:// (or loopback, for the ` +
          `test harness): ${releaseApiBase}`,
      };
    }
  }
  return { releaseApiBase, releaseRepo };
}

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
  /**
   * Progress callback for the out-of-band in-app upgrade (ADR-105): the
   * job reports phases to a status file the dashboard reads. Cosmetic by
   * contract — a throwing callback must never fail the upgrade.
   */
  onPhase?: (phase: "downloading" | "verifying" | "installing") => void;
  /**
   * Last check before the irreversible swap — the new bundle is downloaded,
   * verified and extracted, the live one untouched. The in-app job waits for
   * idle and takes its state snapshot here (ADR-105). Returning
   * `{ proceed: false }` removes the extracted bundle and reports an error;
   * nothing on disk has changed.
   */
  beforeSwap?: () => Promise<
    { proceed: true } | { proceed: false; message: string }
  >;
  /** Test seam for the provenance check. Default: the real one. */
  verifyProvenance?: typeof verifyReleaseProvenance;
  /**
   * The provenance outcome of an update that WILL proceed (after the
   * checksum, before anything changes): verified, or skipped by the
   * operator. "invalid" and "missing" never get here — both return an error
   * and nothing is installed. NOT cosmetic: for "skipped" it's the only
   * channel to the dashboard's warning. A throwing callback still can't
   * change the upgrade's outcome, but it is logged. The same result also
   * rides on the "upgraded" return value.
   */
  onProvenance?: (result: ProceedingProvenance) => void;
};

/** What an update that goes ahead was checked as (ADR-126). */
export type ProceedingProvenance = Extract<
  ProvenanceResult,
  { status: "verified" | "skipped" }
>;

function reportPhase<P>(cb: ((p: P) => void) | undefined, phase: P): void {
  try {
    cb?.(phase);
  } catch (err) {
    // Never let reporting change the upgrade's outcome — but a lost
    // provenance warning must leave a trace.
    console.warn(
      `[upgrade] progress callback failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

export type UpgradeResult =
  | { status: "up-to-date"; version: string }
  | {
      status: "upgraded";
      from: string;
      to: string;
      direction: "upgrade" | "downgrade";
      provenance: ProceedingProvenance;
    }
  /** `postponed`: nothing is wrong with the release as far as we know — its
   *  build record just couldn't be confirmed right now (ADR-126 D). */
  | { status: "error"; message: string; postponed?: true };

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

    reportPhase(opts.onPhase, "downloading");
    await downloadTo(tarball.browser_download_url, tarballPath);
    await downloadTo(sha256sums.browser_download_url, sha256sumsPath);

    // ── verify checksum
    reportPhase(opts.onPhase, "verifying");
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

    // ── verify provenance: the checksum came from the same release, so it
    // can't catch a replaced release. The signed build record can.
    const provenance = await (opts.verifyProvenance ?? verifyReleaseProvenance)(
      {
        digest: actual,
        version: releaseVersion,
        repo,
        apiBase,
        name: tarballName,
      },
    );
    if (provenance.status === "invalid") {
      return {
        status: "error",
        message: `The v${releaseVersion} download doesn't match its signed build record, so it wasn't installed: ${provenance.reason}. If you believe this is wrong, please report it. To install anyway, run \`AUTONOMOS_SKIP_PROVENANCE=1 autonomos upgrade\` in a terminal on the machine running autonomOS.`,
      };
    }
    // Couldn't check → POSTPONE, don't install (Terry, ADR-126 option D).
    // Nothing has changed yet, so waiting can't break the running install;
    // installing would let through exactly what this exists to stop — a
    // tag off main carries a genuine certificate, so "GitHub unreachable or
    // rate-limited" must not be the moment it goes in.
    if (provenance.status === "missing") {
      return {
        status: "error",
        postponed: true,
        message: provenance.lasting
          ? // Waiting won't help (nox, #445): say so, and how to proceed.
            `The v${releaseVersion} update wasn't applied: its signed build record couldn't be confirmed (${provenance.reason}), and retrying won't change that. Nothing changed. Releases before v0.5.0 were never signed; if you trust this one, install it with \`AUTONOMOS_SKIP_PROVENANCE=1 autonomos upgrade\` in a terminal on the machine running autonomOS. Otherwise, please report it.`
          : `The v${releaseVersion} update was postponed: its signed build record couldn't be confirmed (${provenance.reason}). Nothing changed. This is usually temporary (GitHub or Sigstore unreachable, or rate-limited), so try again later. To install it anyway, run \`AUTONOMOS_SKIP_PROVENANCE=1 autonomos upgrade\` in a terminal on the machine running autonomOS.`,
      };
    }
    reportPhase(opts.onProvenance, provenance);

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

    // The bundle must BE the version its tag names. A writer can put tag vN
    // on an OLD commit on main: it passes the "built from main" check, and
    // its signed build is genuinely the old code — installed as "vN" it's a
    // downgrade that then never updates again. Not a provenance check, so it
    // holds even with AUTONOMOS_SKIP_PROVENANCE; a real release never differs.
    const bundleVersion = readBundleVersion(newDir);
    if (bundleVersion !== releaseVersion) {
      rmSync(newDir, { recursive: true, force: true });
      return {
        status: "error",
        message: `The v${releaseVersion} download contains ${
          bundleVersion === "unknown"
            ? "a bundle with no readable version"
            : `v${bundleVersion}`
        }, so it wasn't installed. A release's bundle always matches its tag; please report this.`,
      };
    }

    // The marker travels with the swap — the new bundle must describe itself.
    writeInstallJson(newDir, {
      ...opts.installInfo,
      installedBy: "upgrade",
      installedAt: new Date().toISOString(),
    });

    if (opts.beforeSwap) {
      const go = await opts.beforeSwap();
      if (!go.proceed) {
        rmSync(newDir, { recursive: true, force: true });
        return { status: "error", message: go.message };
      }
    }

    // ── atomic swap (current → previous, new → current)
    reportPhase(opts.onPhase, "installing");
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
      provenance,
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
  const name = url.split("/").pop() ?? url;
  let buf: Buffer;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Download failed (${resp.status}) for ${url}`);
    }
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Download failed")) {
      throw err;
    }
    // undici reports a cut connection as a bare "terminated" / "fetch
    // failed" — say what actually happened. Nothing has changed yet.
    throw new Error(
      `the download of ${name} was interrupted (${err instanceof Error ? err.message : err}) — check the connection and try again`,
    );
  }
  writeFileSync(dest, buf);
}

function computeSha256(path: string): string {
  // node:crypto for portability — shasum may not be available on every host.
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}
