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
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    connections: Array.isArray(current.connections)
      ? current.connections.filter(isValidConnection)
      : defaults.connections,
    defaultConnectionId:
      typeof current.defaultConnectionId === "string"
        ? current.defaultConnectionId
        : defaults.defaultConnectionId,
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
