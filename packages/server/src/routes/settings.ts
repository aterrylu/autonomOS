import { Hono } from "hono";
import { isValidChannelId } from "../channels.js";
import { invalidateCache } from "../plugins/claude-usage/scanner.js";
import {
  type AppSettings,
  getSettings,
  isAutoDetectAccountEnabled,
  updateSettings,
} from "../settings.js";

export const settingsRouter = new Hono();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Redact secrets — show only last 4 chars */
function redact(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••";
  return `••••${value.slice(-4)}`;
}

function maskSettings(settings: AppSettings) {
  return {
    claudeSessionKey: redact(settings.claudeSessionKey),
    autoDetectClaudeAccount: isAutoDetectAccountEnabled(settings),
    channels: settings.channels ?? [],
    autoTrust: settings.autoTrust !== false,
    customEnvVars: settings.customEnvVars ?? {},
    statusLine: { enabled: settings.statusLine?.enabled !== false },
  };
}

settingsRouter.get("/", (c) => {
  return c.json(maskSettings(getSettings()));
});

settingsRouter.put("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const partial: Partial<AppSettings> = {};
  if (typeof body.claudeSessionKey === "string") {
    partial.claudeSessionKey = body.claudeSessionKey.trim();
  }
  // Accept the new key; also accept the legacy `autoDetectClaudeSession` from
  // older dashboards and map it onto the new field.
  if (typeof body.autoDetectClaudeAccount === "boolean") {
    partial.autoDetectClaudeAccount = body.autoDetectClaudeAccount;
  } else if (typeof body.autoDetectClaudeSession === "boolean") {
    partial.autoDetectClaudeAccount = body.autoDetectClaudeSession;
  }
  // `claudeOrgId`, the anthropic* override keys, and `terminalRenderer` are
  // removed features — accept-but-discard for back-compat with older
  // dashboards that still send them; they are never persisted. (A stale
  // `terminalRenderer` already on disk is scrubbed on read in settings.ts.)
  if (typeof body.autoTrust === "boolean") {
    partial.autoTrust = body.autoTrust;
  }
  if (Array.isArray(body.channels)) {
    const requested = body.channels
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());

    const invalid = requested.filter((id) => !isValidChannelId(id));
    if (invalid.length > 0) {
      return c.json(
        {
          error: `Invalid channel identifier(s): ${invalid.join(", ")}. Expected server:<name>.`,
        },
        400,
      );
    }

    partial.channels = requested;
  }
  if (
    isPlainObject(body.statusLine) &&
    typeof body.statusLine.enabled === "boolean"
  ) {
    partial.statusLine = { enabled: body.statusLine.enabled };
  }
  if (isPlainObject(body.customEnvVars)) {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      body.customEnvVars as Record<string, unknown>,
    )) {
      const key = k.trim();
      if (
        key &&
        typeof v === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      ) {
        vars[key] = v;
      }
    }
    partial.customEnvVars = vars;
  }

  let updated: AppSettings;
  try {
    updated = updateSettings(partial);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Failed to save settings:", message);
    return c.json({ error: "Failed to save settings" }, 500);
  }

  // Invalidate usage cache so a credential change takes effect immediately.
  if (
    partial.claudeSessionKey ||
    partial.autoDetectClaudeAccount !== undefined
  ) {
    invalidateCache();
  }

  return c.json(maskSettings(updated));
});
