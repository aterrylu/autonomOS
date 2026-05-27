// Schema migrations for AppConfig. Pragmatic switch-on-version pattern;
// schema changes will be rare for this single-app config file.
//
// To bump schemaVersion N → N+1:
//   1. Update CURRENT_SCHEMA_VERSION + AppConfig.schemaVersion literal
//   2. Add `case N:` that returns the new shape
//   3. Test pinning the migration's behavior

import { type AppConfig, defaultAppConfig } from "../../types/config.js";
import type { Connection } from "../../types/connection.js";

export const CURRENT_SCHEMA_VERSION = 1;

/** Validate a Connection entry from disk. Defensive against hand-edited
 *  config.json where a user might have deleted a required field. */
function isValidConnection(x: unknown): x is Connection {
  if (typeof x !== "object" || x === null) return false;
  const c = x as Connection;
  return (
    typeof c.id === "string" &&
    c.id.length > 0 &&
    typeof c.name === "string" &&
    (c.type === "local" || c.type === "remote") &&
    typeof c.url === "string" &&
    c.url.length > 0 &&
    (c.lastConnectedAt === undefined || typeof c.lastConnectedAt === "string")
  );
}

/** A "remote" connection pointing at localhost / 127.0.0.1 is functionally
 *  identical to the synthesized local connection. Early testing left
 *  duplicates accumulating in config.json. This filter strips them on load
 *  so the Welcome screen doesn't show stale dupes. */
function isLocalhostRemote(c: Connection): boolean {
  if (c.type !== "remote") return false;
  try {
    const host = new URL(c.url).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0"
    );
  } catch {
    return false;
  }
}

export function migrateConfig(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null) {
    return defaultAppConfig();
  }
  const config = raw as Partial<AppConfig> & { schemaVersion?: unknown };

  const fromVersion =
    typeof config.schemaVersion === "number" ? config.schemaVersion : 0;

  let current: Partial<AppConfig>;
  switch (fromVersion) {
    case 0:
      current = config;
      break;
    case CURRENT_SCHEMA_VERSION:
      current = config;
      break;
    default:
      console.warn(
        `[config] schemaVersion ${fromVersion} is newer than supported ` +
          `(${CURRENT_SCHEMA_VERSION}). Loading as-is; some fields may be ignored.`,
      );
      current = config;
      break;
  }

  const defaults = defaultAppConfig();
  const validConnections = Array.isArray(current.connections)
    ? current.connections.filter(isValidConnection)
    : defaults.connections;
  // Dedupe: drop saved "remote" connections that point at localhost — they
  // duplicate the synthesized "This Mac" local card. Logged once at load
  // time so users with prior config can see what got cleaned up.
  const dedupedConnections = validConnections.filter((c) => {
    if (isLocalhostRemote(c)) {
      console.log(
        `[config] removing localhost remote duplicate of This Mac: ${c.url}`,
      );
      return false;
    }
    return true;
  });
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    connections: dedupedConnections,
    openWindows: Array.isArray(current.openWindows)
      ? current.openWindows.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : defaults.openWindows,
    localServer: {
      installed:
        typeof current.localServer?.installed === "boolean"
          ? current.localServer.installed
          : defaults.localServer.installed,
    },
    ui: {
      sidebarWidth:
        typeof current.ui?.sidebarWidth === "number"
          ? current.ui.sidebarWidth
          : defaults.ui.sidebarWidth,
      theme:
        current.ui?.theme === "system" ||
        current.ui?.theme === "light" ||
        current.ui?.theme === "dark"
          ? current.ui.theme
          : defaults.ui.theme,
    },
  };
}
