/**
 * Shared constants across main, preload, and renderer.
 * No imports from electron/node/dom — must be safe to import from any context.
 */

/** Filename for the encrypted-tokens store inside `app.getPath("userData")`. */
export const TOKENS_FILENAME = "tokens.dat" as const;

/** Filename for the JSON app config inside `app.getPath("userData")`. */
export const CONFIG_FILENAME = "config.json" as const;

/** IPC channel names. Centralized so renderer + main + preload reference
 *  the same string. Adding a channel? Add it here first. */
export const IPC = {
  // Config / connections
  CONNECTIONS_LIST: "connections:list",
  CONNECTIONS_ADD: "connections:add",
  CONNECTIONS_REMOVE: "connections:remove",
  CONNECTIONS_SET_DEFAULT: "connections:set-default",

  // Local server install / lifecycle
  LOCAL_SERVER_INSTALL: "local-server:install",
  LOCAL_SERVER_STATUS: "local-server:status",
  LOCAL_SERVER_RESTART: "local-server:restart",
} as const;

/** Polling interval (ms) when waiting for the local server to come up
 *  after `install-service`. */
export const READINESS_POLL_INTERVAL_MS = 500;

/** Maximum time (ms) to wait for the local server to signal readiness
 *  before showing an error. 30s is generous — install + first boot is
 *  typically <5s on a modern Mac. */
export const READINESS_TIMEOUT_MS = 30_000;
