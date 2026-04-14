/**
 * App settings — stored in ~/.autonomos/settings.json
 *
 * Provides a key-value store for dashboard-configurable settings.
 * Plugins and features read from here, with env var fallback.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "./configDir.js";

export interface AppSettings {
  /** Claude session key for usage plugin (sk-ant-sid01-...) */
  claudeSessionKey?: string;
  /** Claude organization ID (UUID) */
  claudeOrgId?: string;
  /** Anthropic API base URL (e.g. http://litellm for proxy) */
  anthropicBaseUrl?: string;
  /** Anthropic API auth token */
  anthropicAuthToken?: string;
  /** Whether to inject anthropicBaseUrl/anthropicAuthToken into sessions (default: true if values exist) */
  anthropicOverrideEnabled?: boolean;
  /**
   * Channel plugins enabled for every session.
   * Values are --channels arguments, e.g.:
   *   "plugin:telegram@claude-plugins-official"
   *   "plugin:discord@claude-plugins-official"
   *   "server:autonomos"
   */
  channels?: string[];
  /** Gateway platform adapter config */
  gateway?: {
    discord?: { enabled: boolean };
    telegram?: { enabled: boolean };
    slack?: { enabled: boolean };
  };
  /** Channel-to-session routing rules */
  routes?: import("@autonomos/core").ChannelRoute[];
  /** Auto-answer Claude Code startup trust prompts (default: true) */
  autoTrust?: boolean;
  /** User-defined env vars injected into every spawned session */
  customEnvVars?: Record<string, string>;
  /** Terminal renderer backend: xterm.js (default) or ghostty-web */
  terminalRenderer?: "xterm" | "ghostty-web";
  /** Scheduler settings */
  scheduler?: {
    maxConcurrentRuns?: number;
  };
}

const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

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
  // Remove keys set to empty string or undefined.
  // Keep empty arrays (e.g. channels: [] means "explicitly none").
  for (const [key, value] of Object.entries(updated)) {
    if (value === "" || value === undefined) {
      delete (updated as Record<string, unknown>)[key];
    }
  }
  ensureConfigDir();
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(updated, null, 2)}\n`, {
    mode: 0o600,
  });
  return updated;
}
