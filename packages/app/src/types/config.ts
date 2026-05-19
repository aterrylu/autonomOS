import type { Connection } from "./connection.js";

/**
 * Persistent application configuration written to
 * `app.getPath("userData")/config.json`. Schema-versioned for forward-compat;
 * migration logic lives in `main/config/migration.ts`.
 *
 * Tokens are NOT in this file. They live separately in `tokens.dat` keyed
 * by connection id and encrypted via Electron's `safeStorage`.
 */
export interface AppConfig {
  /** Schema version. Bump and add migration when the shape changes. */
  schemaVersion: 1;

  /** Remote connections only. The local connection is synthesized at runtime
   *  from `~/.autonomos/server-state.json` and is never stored here. */
  connections: Connection[];

  /** Which connection to auto-open on launch:
   *   - "local" → synthesized local Mac connection (must also have
   *     `localServer.installed === true`)
   *   - other id → matching remote in `connections`
   *   - null → show the Welcome picker
   */
  defaultConnectionId: string | null;

  /** Cached info about the local-machine server. Source of truth is the
   *  daemon's `~/.autonomos/server-state.json`; this is a hint we keep for
   *  fast UI rendering without blocking on file IO. */
  localServer: {
    /** True when a LaunchAgent / systemd-user service exists and the
     *  bundled server has been installed. The "Set up local server" CTA
     *  in Welcome.tsx is hidden when this is true. */
    installed: boolean;

    /** Last-known port from server-state.json. May be stale if the daemon
     *  was restarted on a different port (port=0 → kernel-assigned). */
    port: number | null;
  };

  /** UI preferences. Persisted so the sidebar width / theme survive
   *  app restarts. */
  ui: {
    sidebarWidth: number;
    theme: "system" | "light" | "dark";
  };
}

/** Defaults for a freshly-created config (no prior config file present). */
export function defaultAppConfig(): AppConfig {
  return {
    schemaVersion: 1,
    connections: [],
    defaultConnectionId: null,
    localServer: {
      installed: false,
      port: null,
    },
    ui: {
      sidebarWidth: 240,
      theme: "system",
    },
  };
}
