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
  /** Manual claude.ai session key for the usage plugin (sk-ant-sid01-...).
   * An explicit override of the zero-touch OAuth default. */
  claudeSessionKey?: string;
  /**
   * Auto-detect the Claude account for the usage plugin (default: true).
   * When on, usage is read via Claude Code's local OAuth token (read-only) with
   * no manual paste. Set false to use only an explicitly-entered session key.
   */
  autoDetectClaudeAccount?: boolean;
  /**
   * @deprecated Renamed to {@link autoDetectClaudeAccount}. Read as a fallback
   * for back-compat with older settings.json files; never written by new code.
   */
  autoDetectClaudeSession?: boolean;
  /**
   * @deprecated No longer required or used. The org UUID is resolved
   * automatically from the session key via the bootstrap API. Kept only
   * so older settings.json files still parse; new code never reads it and
   * the settings route no longer persists it.
   */
  claudeOrgId?: string;
  /**
   * Channels enabled for every session. Only `server:*` channels are
   * supported, e.g. "server:autonomos".
   */
  channels?: string[];
  /** Auto-answer Claude Code startup trust prompts (default: true) */
  autoTrust?: boolean;
  /**
   * Check GitHub Releases (server-side, ~daily, cached) for a newer version
   * and surface a passive badge in the dashboard. Default: true — and the
   * README documents exactly that (a doc/behavior mismatch on a phone-home
   * default is a bug in its own right; see Gitea #22078). The dashboard
   * itself never contacts GitHub. Set false (settings panel or API) to
   * disable the check entirely; offline boxes need no setting (a failed
   * check is silent).
   */
  updateCheck?: boolean;
  /** User-defined env vars injected into every spawned session */
  customEnvVars?: Record<string, string>;
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

/**
 * Keys from removed features, scrubbed on read so the next persist drops
 * them from disk (the ADR-035 accept-and-discard pattern). `inboxAgent`
 * and the telegram/discord gateway toggles died with the plugin-channel
 * removal; stale `plugin:*` channels entries are handled by the channels
 * sanitizer below (they no longer pass isValidChannelId). The anthropic*
 * keys died with the API-override removal — the auth token is a credential
 * and must not linger on disk, so scrubbing (not just ignoring) matters.
 * Sessions that need a custom endpoint can set ANTHROPIC_BASE_URL via
 * customEnvVars instead. `terminalRenderer` died with the renderer cleanup
 * — xterm.js is now the only backend, so the selector key is non-credential
 * dead weight; scrubbing it on read prevents it surviving forever (the
 * updateSettings merge spreads current settings, so an un-scrubbed unknown
 * key would re-persist on every save). `gateway` and `routes` died with the
 * platform-adapter removal (ADR-064): the last reader of `gateway` was the
 * adapter connect-loop in initGateway, and the last reader of `routes` was
 * setRoutes — both deleted. Left in place they would be settings that silently
 * do nothing, which is the same class of lie as an ack that isn't one.
 */
const REMOVED_KEYS = [
  "inboxAgent",
  "anthropicBaseUrl",
  "anthropicAuthToken",
  "anthropicOverrideEnabled",
  "terminalRenderer",
  "gateway",
  "routes",
];

function scrubRemovedKeys(data: AppSettings): void {
  const record = data as Record<string, unknown>;
  const dropped = REMOVED_KEYS.filter((key) => key in record);
  for (const key of REMOVED_KEYS) {
    delete record[key];
  }
  if (dropped.length > 0) {
    // Name the keys — for someone who relied on the API override (e.g. a
    // litellm proxy), this is the only signal explaining why their
    // sessions now hit the default endpoint. Key NAMES only, never values
    // (anthropicAuthToken is a credential).
    console.warn(
      `[settings] Ignoring settings.json keys from removed features: ${dropped.join(", ")} (dropped from disk on next save)`,
    );
  }
}

/** One-time guard for {@link migrateUsageCredentialToggle} (idempotent across
 * restarts — after the first write the key exists, so it never fires again). */
let usageToggleMigrated = false;

/** Test hook: re-arm the once-per-process migration guard. */
export function __resetUsageToggleMigrationForTests(): void {
  usageToggleMigrated = false;
}

/**
 * Pre-ADR-075, a saved session key ALWAYS won over the auto-detect (OAuth)
 * path, and the toggle only gated the fallback. Now the toggle SELECTS the
 * source, defaulting ON — which would silently switch every existing
 * key-with-untouched-toggle config onto the Claude Code login's account on
 * upgrade (the inverse of the account-switch defect the change fixes, hitting
 * the users who pasted a key precisely because the accounts differ). Persist
 * their pre-upgrade effective behavior: a saved key with BOTH toggle keys
 * absent means "the key was the source" → write `autoDetectClaudeAccount:
 * false` once. Users who ever touched the toggle are untouched.
 */
function migrateUsageCredentialToggle(data: AppSettings, file: string): void {
  if (usageToggleMigrated) return;
  usageToggleMigrated = true;
  if (
    !data.claudeSessionKey?.trim() ||
    typeof data.autoDetectClaudeAccount === "boolean" ||
    typeof data.autoDetectClaudeSession === "boolean"
  ) {
    return;
  }
  data.autoDetectClaudeAccount = false;
  try {
    // Direct write (not updateSettings — that re-enters getSettings).
    ensureConfigDir();
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    console.log(
      "[settings] migrated: saved session key predates the source-selecting auto-detect toggle — persisted autoDetectClaudeAccount:false to keep the key authoritative (flip the toggle in the usage panel to switch to the Claude Code login)",
    );
  } catch (err) {
    console.warn(`[settings] usage-toggle migration write failed: ${err}`);
  }
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

  scrubRemovedKeys(data);
  migrateUsageCredentialToggle(data, file);

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
      // Name the dropped entries — this is the only signal a user gets
      // when a stale plugin:* channel from a removed integration (or a
      // typo) is discarded. Channel ids are not secrets.
      const dropped = data.channels.filter(
        (c) => typeof c !== "string" || !sanitized.includes(c.trim()),
      );
      console.warn(
        `[settings] Dropped ${dropped.length} invalid channels entries from settings.json: ${JSON.stringify(dropped)}`,
      );
    }
    data.channels = [...new Set(sanitized)];
  }

  return data;
}

/**
 * Whether the usage plugin may auto-detect the Claude account (OAuth path).
 * Default ON. Reads the new `autoDetectClaudeAccount` key, falling back to the
 * deprecated `autoDetectClaudeSession` for back-compat with older configs.
 */
export function isAutoDetectAccountEnabled(settings: AppSettings): boolean {
  if (typeof settings.autoDetectClaudeAccount === "boolean") {
    return settings.autoDetectClaudeAccount;
  }
  if (typeof settings.autoDetectClaudeSession === "boolean") {
    return settings.autoDetectClaudeSession;
  }
  return true;
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
