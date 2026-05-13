// pm2 detection + migration helpers.
//
// Phase 1C transitions existing users from `make prod` + pm2 onto OS-native
// supervision (launchd / systemd-user). The transition is a hard cutover with
// built-in migration on upgrade — no dual-supervisor period — so the migration
// logic needs to be careful: stop pm2's process, deregister, save pm2 state
// (so it doesn't try to restart on reboot), then let install-service handle
// the new supervisor.

import { run } from "./shell.js";

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
  const listed = run("pm2", ["jlist"]);
  if (!listed.ok) return { managed: false }; // pm2 not installed or errored
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

  const count = detection.processes.length;

  const stop = run("pm2", ["stop", "autonomos"]);
  if (!stop.ok) {
    return {
      ok: false,
      message: `pm2 stop autonomos failed: ${stop.stderr.trim()}`,
    };
  }

  const del = run("pm2", ["delete", "autonomos"]);
  if (!del.ok) {
    return {
      ok: false,
      message: `pm2 delete autonomos failed: ${del.stderr.trim()}`,
    };
  }

  // Persist pm2's process list so it doesn't try to bring autonomos back on
  // boot. Best-effort — `pm2 save` can return non-zero in some setups but
  // the migration is still valid.
  run("pm2", ["save"]);

  return { ok: true, stopped: count };
}
