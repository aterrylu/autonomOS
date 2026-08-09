// install.json — the recorded install-shape marker (ADR-077).
//
// The updater must never GUESS its install shape: path-sniffing is the failure
// class behind Claude Code #28625 (native install misdetected as npm-global →
// symlink deleted) and most of Gemini CLI's updater bugs (reported success
// while the old binary kept running). Instead, install.sh writes install.json
// INTO the bundle directory at install time, and every later upgrade rewrites
// it into the new bundle before the atomic swap, so the marker always
// describes the directory it sits in.
//
// Installs that predate the marker (Netdata's "empty arm"): a bundle laid out
// as <prefix>/share/autonomos is recognized as a legacy bundle install and
// treated as mode "bundle". Anything else — a dev checkout under tsx, an
// unrecognized layout — resolves to a hard error with instructions, never a
// guess.
//
// Mode "source" (a managed git clone updated by tag checkout) is part of the
// schema now so a newer install.json loads cleanly here, but this release
// only performs bundle-mode upgrades — resolution succeeds and the CALLER
// decides what "source" means (the upgrade command refuses with instructions
// until source-mode upgrade ships).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve as pathResolve } from "node:path";

export const INSTALL_JSON = "install.json";

export const INSTALL_MODES = ["bundle", "source"] as const;
export type InstallMode = (typeof INSTALL_MODES)[number];

function isInstallMode(value: unknown): value is InstallMode {
  return INSTALL_MODES.includes(value as InstallMode);
}

export type InstallInfo = {
  /** How this install is laid out — decides which upgrade backend applies. */
  mode: InstallMode;
  /** Install prefix (bundle mode: the dir containing share/ and bin/). */
  prefix: string;
  /** Which tool wrote the marker (install.sh, upgrade, …). Informational. */
  installedBy?: string;
  /** ISO timestamp of the write. Informational. */
  installedAt?: string;
};

export type ResolvedInstall = {
  /** Directory the running bundle lives in (contains index.js). */
  bundleDir: string;
  info: InstallInfo;
  /** Whether the marker was read from disk or inferred from the legacy layout. */
  source: "marker" | "legacy-layout";
};

export function readInstallJson(bundleDir: string): InstallInfo | null {
  const path = join(bundleDir, INSTALL_JSON);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<InstallInfo>;
    if (!isInstallMode(raw.mode) || typeof raw.prefix !== "string") {
      // Present-but-invalid must not be silently conflated with absent: the
      // caller falls through to legacy inference (papering over corruption)
      // or to an error that says "No install.json found" — false, and it
      // sends the operator down the wrong path.
      console.warn(
        `[install] ${path} exists but is not a valid install marker — ignoring it`,
      );
      return null;
    }
    return {
      mode: raw.mode,
      prefix: raw.prefix,
      installedBy:
        typeof raw.installedBy === "string" ? raw.installedBy : undefined,
      installedAt:
        typeof raw.installedAt === "string" ? raw.installedAt : undefined,
    };
  } catch {
    console.warn(
      `[install] ${path} exists but is not parseable JSON — ignoring it`,
    );
    return null;
  }
}

export function writeInstallJson(bundleDir: string, info: InstallInfo): void {
  writeFileSync(
    join(bundleDir, INSTALL_JSON),
    `${JSON.stringify(info, null, 2)}\n`,
  );
}

/**
 * Resolve the install this process is running from. `scriptPath` is
 * process.argv[1] (parameterized for tests).
 *
 * Resolution order:
 *   1. install.json next to the entry script → trust the marker.
 *   2. Legacy layout <prefix>/share/autonomos → bundle mode, derived prefix
 *      (installs made before the marker existed).
 *   3. Anything else → throw with instructions. NEVER guess.
 */
export function resolveInstall(
  scriptPath: string | undefined = process.argv[1],
): ResolvedInstall {
  if (!scriptPath) {
    throw new Error("Cannot resolve install: process.argv[1] is missing");
  }
  const bundleDir = pathResolve(scriptPath, "..");

  const marker = readInstallJson(bundleDir);
  if (marker) return { bundleDir, info: marker, source: "marker" };

  // Legacy arm: bundle installs made before install.json existed.
  if (
    basename(bundleDir) === "autonomos" &&
    basename(dirname(bundleDir)) === "share"
  ) {
    return {
      bundleDir,
      source: "legacy-layout",
      info: { mode: "bundle", prefix: dirname(dirname(bundleDir)) },
    };
  }

  throw new Error(
    `Cannot determine install shape for: ${scriptPath}\n` +
      `No ${INSTALL_JSON} found in ${bundleDir} and the layout doesn't match ` +
      `a bundle install (<prefix>/share/autonomos).\n` +
      `- Installed via curl|sh? Re-run the installer to record the marker.\n` +
      `- Running from a dev checkout? Update with: git pull && make prod`,
  );
}
