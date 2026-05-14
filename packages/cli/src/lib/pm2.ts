// pm2 detection + migration helpers.
//
// Phase 1C transitions existing users from `make prod` + pm2 onto OS-native
// supervision (launchd / systemd-user). The transition is a hard cutover with
// built-in migration on upgrade — no dual-supervisor period — so the migration
// logic needs to be careful: stop pm2's process, deregister, save pm2 state
// (so it doesn't try to restart on reboot), then let install-service handle
// the new supervisor.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { run } from "./shell.js";

/**
 * pm2 often lives outside the default PATH (e.g., $HOME/.bun/bin/pm2 when
 * installed via `bun add -g pm2`, which is what the existing `make prod`
 * deployment does). Walk a few well-known locations explicitly so that
 * non-interactive shells (CI runners, install.sh sourced from curl) can
 * find an installed pm2 reliably.
 *
 * Returns the path to a runnable pm2 binary, or null if none found.
 */
function findPm2Binary(): string | null {
  const home = homedir();
  const candidates = [
    "pm2", // try plain PATH first
    `${home}/.bun/bin/pm2`,
    `${home}/.local/bin/pm2`,
    `${home}/.volta/bin/pm2`,
    "/usr/local/bin/pm2",
    "/opt/homebrew/bin/pm2",
  ];
  for (const path of candidates) {
    // For absolute paths, fs.existsSync gives a fast no-op when missing
    if (path.startsWith("/") && !existsSync(path)) continue;
    const probe = run(path, ["--version"]);
    if (probe.ok) return path;
  }
  return null;
}

type Pm2Process = {
  name: string;
  pid?: number;
  pm2_env?: {
    status?: string;
    env?: Record<string, string | number | undefined>;
  };
};

export type Pm2Detection =
  | { managed: false }
  | { managed: true; processes: Pm2Process[]; port: number | undefined };

/**
 * Extract the PORT env var from any of the discovered pm2 processes. Used by
 * migrate-from-pm2 to preserve the port when handing off to install-service.
 */
function extractPort(processes: Pm2Process[]): number | undefined {
  for (const p of processes) {
    const raw = p.pm2_env?.env?.PORT;
    if (typeof raw === "number" && Number.isInteger(raw)) return raw;
    if (typeof raw === "string") {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
    }
  }
  return undefined;
}

/**
 * Detect whether pm2 is installed AND has a process named "autonomos" in its
 * list. Returns { managed: false } if pm2 is absent or has no autonomos entry.
 */
export function detectPm2Install(): Pm2Detection {
  const pm2Bin = findPm2Binary();
  if (!pm2Bin) return { managed: false }; // pm2 not installed anywhere we know
  const listed = run(pm2Bin, ["jlist"]);
  if (!listed.ok) return { managed: false };
  try {
    const all = JSON.parse(listed.stdout) as Pm2Process[];
    const autonomos = all.filter((p) => p.name === "autonomos");
    if (autonomos.length === 0) return { managed: false };
    return {
      managed: true,
      processes: autonomos,
      port: extractPort(autonomos),
    };
  } catch {
    return { managed: false };
  }
}

export type Pm2MigrationResult =
  | { ok: true; stopped: number }
  | { ok: false; message: string };

/**
 * Stop and deregister the pm2-managed autonomos process. Saves pm2 state so
 * it won't try to bring autonomos back on next reboot.
 *
 * Does NOT install the new supervisor — the caller is expected to follow up
 * with `autonomos install-service`.
 */
export function migrateFromPm2(): Pm2MigrationResult {
  const detection = detectPm2Install();
  if (!detection.managed) {
    return { ok: true, stopped: 0 };
  }

  const pm2Bin = findPm2Binary();
  if (!pm2Bin) {
    // Defensive: if detectPm2Install said managed=true, findPm2Binary should
    // also have succeeded. Surface a useful error rather than crashing.
    return {
      ok: false,
      message: "pm2 binary not found despite earlier detection",
    };
  }

  const count = detection.processes.length;

  const stop = run(pm2Bin, ["stop", "autonomos"]);
  if (!stop.ok) {
    return {
      ok: false,
      message: `pm2 stop autonomos failed: ${stop.stderr.trim()}`,
    };
  }

  const del = run(pm2Bin, ["delete", "autonomos"]);
  if (!del.ok) {
    return {
      ok: false,
      message: `pm2 delete autonomos failed: ${del.stderr.trim()}`,
    };
  }

  // Persist pm2's empty (or no-autonomos) process list so it doesn't try to
  // bring autonomos back on boot via `pm2 resurrect`. `pm2 save` without
  // --force REFUSES to overwrite the dump if the current process list is
  // empty (safety against accidental wipe) — but that's exactly our case
  // after deleting autonomos, so --force is mandatory here.
  //
  // Note: if the user has other apps managed by pm2 besides autonomos,
  // `pm2 save --force` correctly preserves them in the dump while dropping
  // the autonomos entry. Same path either way.
  run(pm2Bin, ["save", "--force"]);

  return { ok: true, stopped: count };
}
