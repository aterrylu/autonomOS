/**
 * Schema migrations for AppConfig.
 *
 * Pragmatic pattern (borrowed from Open WebUI Desktop, src/main/index.ts:2177):
 * migrations are inline functions keyed by source version. We don't pull in
 * a migrations framework because schema changes will be rare for this
 * single-app config file.
 *
 * To add a migration when bumping schemaVersion from N → N+1:
 *   1. Bump AppConfig.schemaVersion type literal to N+1
 *   2. Add a function `migrateV${N}toV${N+1}(prev)` that returns the new shape
 *   3. Add a case to the switch in `migrateConfig`
 *   4. Write a unit test pinning the migration's behavior
 *
 * Old fields that the new schema doesn't use can be either dropped silently
 * (preferred) or logged via console.warn — the user's data is lost unless
 * the new schema captures it, so prefer migrations that PRESERVE information
 * even if the new code doesn't read it yet.
 */

import { type AppConfig, defaultAppConfig } from "../../types/config.js";

/** Migrate a raw parsed JSON object to the current AppConfig schema.
 *  Tolerant of garbage input — falls back to defaults if the input doesn't
 *  look like a config at all. */
export function migrateConfig(raw: unknown): AppConfig {
  if (typeof raw !== "object" || raw === null) {
    return defaultAppConfig();
  }
  const config = raw as Partial<AppConfig> & { schemaVersion?: unknown };

  // No version field → either a brand-new file or pre-versioning. Either way,
  // try to interpret what we have at the current schema and fill gaps.
  const fromVersion =
    typeof config.schemaVersion === "number" ? config.schemaVersion : 0;

  let current: AppConfig;
  switch (fromVersion) {
    case 0:
      current = fromV0(config);
      break;
    case 1:
      current = config as AppConfig;
      break;
    default:
      // Newer schema than we know about → treat as current and hope for the
      // best. Don't downgrade silently.
      console.warn(
        `[config] Config schemaVersion ${fromVersion} is newer than supported ` +
          `(${1}). Loading as-is; some fields may be ignored.`,
      );
      current = config as AppConfig;
      break;
  }

  // Always ensure required nested fields exist (defaults merge), so future
  // additions to AppConfig don't crash on old configs that lack them.
  const defaults = defaultAppConfig();
  return {
    schemaVersion: 1,
    connections: current.connections ?? defaults.connections,
    defaultConnectionId:
      current.defaultConnectionId ?? defaults.defaultConnectionId,
    localServer: {
      installed:
        current.localServer?.installed ?? defaults.localServer.installed,
      port: current.localServer?.port ?? defaults.localServer.port,
    },
    ui: {
      sidebarWidth: current.ui?.sidebarWidth ?? defaults.ui.sidebarWidth,
      theme: current.ui?.theme ?? defaults.ui.theme,
    },
  };
}

/** Pre-versioning shape → v1. Used when the file has no `schemaVersion`. */
function fromV0(prev: Partial<AppConfig>): AppConfig {
  const defaults = defaultAppConfig();
  return {
    schemaVersion: 1,
    connections: Array.isArray(prev.connections) ? prev.connections : [],
    defaultConnectionId: prev.defaultConnectionId ?? null,
    localServer: prev.localServer ?? defaults.localServer,
    ui: prev.ui ?? defaults.ui,
  };
}
