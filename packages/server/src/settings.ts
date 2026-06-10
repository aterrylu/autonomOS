/**
 * App settings — stored in ~/.autonomos/settings.json
 *
 * Provides a key-value store for dashboard-configurable settings.
 * Plugins and features read from here, with env var fallback.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isValidChannelId } from "./channels.js";
import { ensureConfigDir, getConfigDir } from "./configDir.js";

export interface AppSettings {
  /** Claude session key for usage plugin (sk-ant-sid01-...) */
  claudeSessionKey?: string;
  /**
   * @deprecated No longer required or used. The org UUID is resolved
   * automatically from the session key via the bootstrap API. Kept only
   * so older settings.json files still parse; new code never reads it and
   * the settings route no longer persists it.
   */
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
  /**
   * Name of the agent that gets plugin:* channels (Telegram, Discord, etc).
   * Only ONE session can hold a given plugin's lock — Telegram's getUpdates
   * API enforces a single concurrent poller per bot token, and the plugin
   * implements this with a PID file that evicts previous holders. Pinning
   * plugin channels to one agent avoids the random-last-wins routing you'd
   * otherwise get when many sessions resume in parallel.
   * Default: "Dispatcher". Non-matching sessions still get server:* channels.
   */
  inboxAgent?: string;
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
  /**
   * Statusline injected into spawned CC sessions.
   * When `enabled` (default true), an autonomOS-aware statusline replaces
   * the user's personal `~/.claude/settings.json` statusLine for spawned
   * sessions only. Set `enabled: false` to fall back to the personal config.
   */
  statusLine?: {
    enabled: boolean;
  };
}

function settingsFile(): string {
  return join(getConfigDir(), "settings.json");
}

const DEFAULT_CHANNELS = ["server:autonomos"];
const DEFAULT_INBOX_AGENT = "Dispatcher";

export function getInboxAgent(settings: AppSettings): string {
  const name = settings.inboxAgent?.trim();
  return name && name.length > 0 ? name : DEFAULT_INBOX_AGENT;
}

export function getSettings(): AppSettings {
  let data: AppSettings;
  const file = settingsFile();
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      console.warn(
        `Settings file ${file} does not contain a JSON object — ignoring`,
      );
      data = {};
    } else {
      data = parsed as AppSettings;
    }
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && "code" in err && err.code === "ENOENT";
    if (!isNotFound) {
      console.warn(`Failed to read settings: ${err}`);
    }
    data = {};
  }

  // Default channels so MCP tools work out of the box.
  // An explicit empty array means "user disabled all channels" — don't override.
  if (data.channels == null || !Array.isArray(data.channels)) {
    data.channels = DEFAULT_CHANNELS;
  } else if (data.channels.length > 0) {
    // Sanitize: strip non-strings and malformed tags so bad values
    // written out-of-band (hand-edit, older builds) don't silently
    // re-persist on the next `updateSettings()` merge or crash the
    // spawn path via non-string entries.
    const sanitized = data.channels
      .filter((c): c is string => typeof c === "string")
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && isValidChannelId(c));
    if (sanitized.length !== data.channels.length) {
      console.warn(
        `[settings] Dropped ${data.channels.length - sanitized.length} invalid channels entries from settings.json`,
      );
    }
    data.channels = [...new Set(sanitized)];
  }

  return data;
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
  writeFileSync(settingsFile(), `${JSON.stringify(updated, null, 2)}\n`, {
    mode: 0o600,
  });
  return updated;
}
