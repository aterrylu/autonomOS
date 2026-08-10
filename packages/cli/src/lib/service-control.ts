// Supervisor control — start/stop/restart the installed launchd / systemd-user
// service. Shared by `autonomos stop` and `autonomos restart` so the launchd
// quirks (KeepAlive revival, bootout vs kickstart) live in one place.
//
// WHY this is non-trivial: under launchd `KeepAlive=true` / systemd
// `Restart=always`, a bare SIGTERM to the daemon just makes the supervisor
// revive it. To actually stop it you must tell the SUPERVISOR (launchctl
// bootout / systemctl stop). To restart you ask the supervisor to cycle it
// (launchctl kickstart -k / systemctl restart), with a bootstrap fallback on
// macOS in case the job was previously booted out.

import { existsSync } from "node:fs";
import { defaultPrefix, getServicePaths } from "./service-paths.js";
import { serviceLabel, systemdUnitName } from "./service-templates.js";
import { type RunResult, run } from "./shell.js";

export type InstalledService = {
  platform: "darwin" | "linux";
  serviceFile: string;
  uid: number;
};

/** The installed service, or null if none is on disk / platform unsupported. */
export function findInstalledService(): InstalledService | null {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return null;
  }
  try {
    const { serviceFile } = getServicePaths(defaultPrefix());
    if (!existsSync(serviceFile)) return null;
    return {
      platform: process.platform,
      serviceFile,
      uid: process.getuid?.() ?? 0,
    };
  } catch (err) {
    // A genuine detection error (not "absent") would otherwise masquerade as
    // "no service" and misroute stop → SIGTERM (which a supervisor revives).
    // Surface it instead of silently conflating the two states.
    console.warn(
      "[service] could not determine installed-service state:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// systemctl --user needs a user bus; over a non-login shell XDG_RUNTIME_DIR may
// be unset. Best-effort set it (Linux only) so stop/restart work over ssh.
export function ensureUserBusEnv(): void {
  if (process.platform === "linux" && !process.env.XDG_RUNTIME_DIR) {
    const uid = process.getuid?.() ?? 0;
    process.env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  }
}

/** Restart the installed service via its supervisor. */
export function restartService(svc: InstalledService): RunResult {
  if (svc.platform === "darwin") {
    const target = `gui/${svc.uid}/${serviceLabel()}`;
    const kick = run("launchctl", ["kickstart", "-k", target]);
    if (kick.ok) return kick;
    // Not currently bootstrapped (e.g. after `autonomos stop`) — load it, which
    // starts it via RunAtLoad.
    return run("launchctl", ["bootstrap", `gui/${svc.uid}`, svc.serviceFile]);
  }
  ensureUserBusEnv();
  return run("systemctl", ["--user", "restart", systemdUnitName()]);
}

// Synchronous sleep for the bootstrap retry below — this module is
// spawnSync-based throughout, so an async sleep has nothing to await it.
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Restart that also RE-READS the service file. Required after a unit rewrite
 * (service-sync drift): on macOS `kickstart -k` restarts the job definition
 * launchd already has LOADED and never re-reads the plist — only
 * bootout+bootstrap does. On Linux a plain restart already follows the
 * daemon-reload the sync issued, so the two restarts are the same command.
 *
 * Unlike restartService(), the bootout makes the bootstrap LOAD-BEARING:
 * between the two calls the job is removed from launchd, so a failed
 * bootstrap leaves the daemon DOWN, not "still on the old version". Two
 * consequences: (a) `launchctl bootout` can return before teardown of a
 * live process completes, making an immediate bootstrap fail with
 * "Operation already in progress" — so bootstrap is retried on a short
 * bounded backoff instead of giving up on the first attempt; (b) the caller
 * must describe a persistent failure as "service may be unloaded — run
 * autonomos restart", whose bootstrap fallback recovers it (see
 * apply-bundle.ts).
 */
export function restartServiceReloading(
  svc: InstalledService,
  deps: {
    runCmd?: (cmd: string, args: readonly string[]) => RunResult;
    sleep?: (ms: number) => void;
  } = {},
): RunResult {
  const runCmd = deps.runCmd ?? run;
  const sleep = deps.sleep ?? sleepMs;
  if (svc.platform === "darwin") {
    // bootout may fail if the job isn't currently loaded — that's fine, the
    // bootstrap below is what re-reads the plist and starts it.
    runCmd("launchctl", ["bootout", `gui/${svc.uid}/${serviceLabel()}`]);
    let result = runCmd("launchctl", [
      "bootstrap",
      `gui/${svc.uid}`,
      svc.serviceFile,
    ]);
    for (let attempt = 0; !result.ok && attempt < 5; attempt++) {
      sleep(500);
      result = runCmd("launchctl", [
        "bootstrap",
        `gui/${svc.uid}`,
        svc.serviceFile,
      ]);
    }
    return result;
  }
  ensureUserBusEnv();
  return runCmd("systemctl", ["--user", "restart", systemdUnitName()]);
}

/** Stop the installed service so the supervisor won't immediately revive it. */
export function stopService(svc: InstalledService): RunResult {
  if (svc.platform === "darwin") {
    // bootout removes the job from launchd → KeepAlive can't revive it.
    // `autonomos restart` / `start`'s bootstrap path brings it back.
    return run("launchctl", ["bootout", `gui/${svc.uid}/${serviceLabel()}`]);
  }
  ensureUserBusEnv();
  return run("systemctl", ["--user", "stop", systemdUnitName()]);
}
