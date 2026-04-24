import { Hono } from "hono";
import { channelStatus, isValidChannelId } from "../channels.js";
import { invalidateCache } from "../plugins/claude-usage/scanner.js";
import {
  type AppSettings,
  getInboxAgent,
  getSettings,
  updateSettings,
} from "../settings.js";
import { readInstalledPlugins } from "./channels.js";

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
    inboxAgent: getInboxAgent(settings),
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
  if (typeof body.inboxAgent === "string") {
    partial.inboxAgent = body.inboxAgent.trim();
  }
  if (Array.isArray(body.channels)) {
    const requested = body.channels
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());

    const invalid = requested.filter((id) => !isValidChannelId(id));
    if (invalid.length > 0) {
      return c.json(
        {
          error: `Invalid channel identifier(s): ${invalid.join(", ")}. Expected plugin:<name>@<marketplace> or server:<name>.`,
        },
        400,
      );
    }

    // When detection fails, readInstalledPlugins returns null, which
    // channelStatus() translates to "unknown" — deliberately fail-open
    // so a transient subprocess problem doesn't block legitimate saves.
    let installed: Awaited<ReturnType<typeof readInstalledPlugins>>;
    try {
      installed = await readInstalledPlugins();
    } catch (err) {
      console.error("[settings] channel detection threw:", err);
      return c.json(
        { error: "Could not verify channel status — try again." },
        500,
      );
    }

    const broken: string[] = [];
    for (const id of requested) {
      const status = channelStatus(id, installed);
      if (status === "not-installed" || status === "disabled") {
        broken.push(`${id} (${status})`);
      }
    }
    if (broken.length > 0) {
      return c.json(
        {
          error: `Refusing to save channels that would silently no-op at spawn: ${broken.join(", ")}. Install or enable the plugin first.`,
        },
        400,
      );
    }

    partial.channels = requested;
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
