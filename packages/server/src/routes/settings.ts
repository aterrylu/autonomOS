import { Hono } from "hono";
import { invalidateCache } from "../plugins/claude-usage/scanner.js";
import { type AppSettings, getSettings, updateSettings } from "../settings.js";

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
    claudeOrgId: settings.claudeOrgId || null,
    anthropicBaseUrl: settings.anthropicBaseUrl || null,
    anthropicAuthToken: redact(settings.anthropicAuthToken),
    anthropicOverrideEnabled: settings.anthropicOverrideEnabled !== false,
    channels: settings.channels ?? [],
    autoTrust: settings.autoTrust !== false,
    customEnvVars: settings.customEnvVars ?? {},
    terminalRenderer: settings.terminalRenderer ?? "xterm",
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
  if (typeof body.claudeOrgId === "string") {
    partial.claudeOrgId = body.claudeOrgId.trim();
  }
  if (typeof body.anthropicBaseUrl === "string") {
    partial.anthropicBaseUrl = body.anthropicBaseUrl.trim();
  }
  if (typeof body.anthropicAuthToken === "string") {
    partial.anthropicAuthToken = body.anthropicAuthToken.trim();
  }
  if (typeof body.anthropicOverrideEnabled === "boolean") {
    partial.anthropicOverrideEnabled = body.anthropicOverrideEnabled;
  }
  if (typeof body.autoTrust === "boolean") {
    partial.autoTrust = body.autoTrust;
  }
  if (Array.isArray(body.channels)) {
    partial.channels = body.channels.filter(
      (c): c is string => typeof c === "string" && c.trim().length > 0,
    );
  }
  if (
    body.terminalRenderer === "xterm" ||
    body.terminalRenderer === "ghostty-web"
  ) {
    partial.terminalRenderer = body.terminalRenderer;
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

  // Invalidate usage cache so new credentials take effect immediately
  if (partial.claudeSessionKey || partial.claudeOrgId) {
    invalidateCache();
  }

  return c.json(maskSettings(updated));
});
