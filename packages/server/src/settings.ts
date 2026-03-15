/**
 * App settings — stored in ~/.autonomos/settings.json
 *
 * Provides a key-value store for dashboard-configurable settings.
 * Plugins and features read from here, with env var fallback.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface AppSettings {
  /** Claude session key for usage plugin (sk-ant-sid01-...) */
  claudeSessionKey?: string;
  /** Claude organization ID (UUID) */
  claudeOrgId?: string;
}

const HOME = process.env.HOME;
if (!HOME) throw new Error("HOME environment variable is not set");
const CONFIG_DIR = join(HOME, ".autonomos");
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function getSettings(): AppSettings {
  try {
    const raw = readFileSync(SETTINGS_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return {};
    }
    return data as AppSettings;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {};
    }
    console.warn(`Failed to read settings: ${err}`);
    return {};
  }
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const updated = { ...current, ...partial };
  // Remove keys set to empty string or undefined
  for (const [key, value] of Object.entries(updated)) {
    if (value === "" || value === undefined) {
      delete (updated as Record<string, unknown>)[key];
    }
  }
  ensureConfigDir();
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(updated, null, 2)}\n`);
  return updated;
}
