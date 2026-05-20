import type { Connection } from "./connection.js";

/**
 * Persistent application configuration at `app.getPath("userData")/config.json`.
 * Schema-versioned for forward-compat — migration logic in
 * `main/config/migration.ts`.
 *
 * Tokens are NOT in this file. They live in `tokens.dat` keyed by connection
 * id and encrypted via Electron `safeStorage`. See `main/config/tokens.ts`.
 */
export interface AppConfig {
  schemaVersion: 1;

  /** Remote connections only. The local connection is synthesized at runtime
   *  from `~/.autonomos/autonomos.pid` and is never stored here. */
  connections: Connection[];

  /** Connection IDs whose windows were open at last quit, restored on
   *  next launch (VS Code "reopen workspaces" behavior). Updated whenever
   *  a connection window opens or closes. */
  openWindows: string[];

  /** Whether a local autonomos-server LaunchAgent / systemd-user service
   *  has been installed on this machine. Source of truth for the live
   *  daemon's port/pid/version is `~/.autonomos/autonomos.pid` (read fresh
   *  at every connect attempt; not cached here). */
  localServer: {
    installed: boolean;
  };

  ui: {
    sidebarWidth: number;
    theme: "system" | "light" | "dark";
  };
}

/** Defaults for a freshly-created config (no prior file present). Returns
 *  a fresh object on each call so callers can mutate without aliasing the
 *  defaults instance. */
export function defaultAppConfig(): AppConfig {
  return {
    schemaVersion: 1,
    connections: [],
    openWindows: [],
    localServer: { installed: false },
    ui: { sidebarWidth: 240, theme: "system" },
  };
}
