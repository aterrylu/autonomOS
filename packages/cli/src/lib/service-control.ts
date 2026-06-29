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
import { LAUNCHAGENT_LABEL, SYSTEMD_UNIT_NAME } from "./service-templates.js";
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
function ensureUserBusEnv(): void {
  if (process.platform === "linux" && !process.env.XDG_RUNTIME_DIR) {
    const uid = process.getuid?.() ?? 0;
    process.env.XDG_RUNTIME_DIR = `/run/user/${uid}`;
  }
}

/** Restart the installed service via its supervisor. */
export function restartService(svc: InstalledService): RunResult {
  if (svc.platform === "darwin") {
    const target = `gui/${svc.uid}/${LAUNCHAGENT_LABEL}`;
    const kick = run("launchctl", ["kickstart", "-k", target]);
    if (kick.ok) return kick;
    // Not currently bootstrapped (e.g. after `autonomos stop`) — load it, which
    // starts it via RunAtLoad.
    return run("launchctl", ["bootstrap", `gui/${svc.uid}`, svc.serviceFile]);
  }
  ensureUserBusEnv();
  return run("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]);
}

/** Stop the installed service so the supervisor won't immediately revive it. */
export function stopService(svc: InstalledService): RunResult {
  if (svc.platform === "darwin") {
    // bootout removes the job from launchd → KeepAlive can't revive it.
    // `autonomos restart` / `start`'s bootstrap path brings it back.
    return run("launchctl", ["bootout", `gui/${svc.uid}/${LAUNCHAGENT_LABEL}`]);
  }
  ensureUserBusEnv();
  return run("systemctl", ["--user", "stop", SYSTEMD_UNIT_NAME]);
}
