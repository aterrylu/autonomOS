import {
  type MaskedSettings,
  PERMISSION_RUNTIMES,
  type Provider,
  parseRuntimePermission,
  type RuntimePermission,
} from "@autonomos/core";
import { Hono } from "hono";
import { isValidChannelId } from "../channels.js";
import { invalidateCache } from "../plugins/claude-usage/scanner.js";
import {
  type AppSettings,
  getSettings,
  isAutoDetectAccountEnabled,
  runtimeDefaultPermission,
  updateSettings,
} from "../settings.js";
import { parseBody, restUpdateSettingsSchema } from "../validation.js";

export const settingsRouter = new Hono();

/** Redact secrets — show only last 4 chars */
function redact(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••";
  return `••••${value.slice(-4)}`;
}

function maskSettings(settings: AppSettings): MaskedSettings {
  return {
    claudeSessionKey: redact(settings.claudeSessionKey),
    autoDetectClaudeAccount: isAutoDetectAccountEnabled(settings),
    channels: settings.channels ?? [],
    autoTrust: settings.autoTrust !== false,
    updateCheck: settings.updateCheck !== false,
    customEnvVars: settings.customEnvVars ?? {},
    statusLine: { enabled: settings.statusLine?.enabled !== false },
    runtimeDefaults: Object.fromEntries(
      PERMISSION_RUNTIMES.map((r) => [
        r,
        runtimeDefaultPermission(r, settings),
      ]),
    ) as Record<Provider, RuntimePermission>,
  };
}

settingsRouter.get("/", (c) => {
  return c.json(maskSettings(getSettings()));
});

settingsRouter.put("/", async (c) => {
  // Shape only. The two value-level rules below — channel-id format and the
  // env-var-name filter — are domain validation and stay here: one 400s with a
  // message naming the offending ids, the other drops silently, and neither is
  // expressible as "this field is a string".
  const body = await parseBody(c, restUpdateSettingsSchema);

  const partial: Partial<AppSettings> = {};
  if (body.claudeSessionKey !== undefined) {
    partial.claudeSessionKey = body.claudeSessionKey.trim();
  }
  // Accept the new key; also accept the legacy `autoDetectClaudeSession` from
  // older dashboards and map it onto the new field.
  if (body.autoDetectClaudeAccount !== undefined) {
    partial.autoDetectClaudeAccount = body.autoDetectClaudeAccount;
  } else if (body.autoDetectClaudeSession !== undefined) {
    partial.autoDetectClaudeAccount = body.autoDetectClaudeSession;
  }
  // `claudeOrgId`, the anthropic* override keys, and `terminalRenderer` are
  // removed features — undeclared in the schema, so zod strips them. That is
  // the same accept-but-discard older dashboards have always got; they are
  // never persisted. (A stale `terminalRenderer` already on disk is scrubbed on
  // read in settings.ts.)
  if (body.autoTrust !== undefined) {
    partial.autoTrust = body.autoTrust;
  }
  // A default-ON phone-home whose off switch only exists as a hand-edited
  // JSON key isn't a real off switch — the flag is settable through the
  // same API/panel as every other toggle.
  if (body.updateCheck !== undefined) {
    partial.updateCheck = body.updateCheck;
  }
  if (body.channels !== undefined) {
    const requested = body.channels
      .filter((v) => v.trim().length > 0)
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
  if (body.statusLine?.enabled !== undefined) {
    partial.statusLine = { enabled: body.statusLine.enabled };
  }
  if (body.customEnvVars !== undefined) {
    const vars: Record<string, string> = {};
    for (const [k, v] of Object.entries(body.customEnvVars)) {
      const key = k.trim();
      if (key && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        vars[key] = v;
      }
    }
    partial.customEnvVars = vars;
  }

  if (body.runtimeDefaults !== undefined) {
    // Merge per runtime: naming one runtime leaves the others' defaults alone;
    // `null` resets a runtime to the built-in default. Stored as the COMPLETE
    // canonical values, so a later table default change can't shift it.
    const next = { ...(getSettings().runtimeDefaults ?? {}) };
    for (const [runtime, input] of Object.entries(body.runtimeDefaults) as [
      Provider,
      string | Record<string, string> | null,
    ][]) {
      if (input === null) {
        delete next[runtime];
        continue;
      }
      const parsed = parseRuntimePermission(runtime, input);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      next[runtime] = { ...parsed.permission.values };
    }
    partial.runtimeDefaults = next;
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
