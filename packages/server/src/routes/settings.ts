import {
  type MaskedSettings,
  neverAsks,
  PERMISSION_RUNTIMES,
  type Provider,
  parseRuntimePermission,
  type RuntimePermission,
  widerAxes,
} from "@autonomos/core";
import { Hono } from "hono";
import { isValidChannelId } from "../channels.js";
import { invalidateCache } from "../plugins/claude-usage/scanner.js";
import {
  noteRuntimeDefaults,
  runtimeDefaultsLog,
} from "../runtimeDefaultsWatch.js";
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
    runtimeDefaultsLog: runtimeDefaultsLog(settings),
  };
}

settingsRouter.get("/", (c) => {
  const settings = getSettings();
  // Reading the defaults is where an out-of-band edit (settings.json changed
  // directly) gets noticed and reported (ADR-122).
  noteRuntimeDefaults(settings);
  return c.json(maskSettings(settings));
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
    // Report anything changed out-of-band BEFORE applying this write, so the
    // write's own report says only what the dashboard changed.
    const current = getSettings();
    noteRuntimeDefaults(current);
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
    // A default under which new agents NEVER ask before acting must be
    // confirmed explicitly (the dashboard's confirm dialog sends it) whenever
    // the change widens anything. Re-saving it, or narrowing it, doesn't.
    const widened = (Object.keys(body.runtimeDefaults) as Provider[]).filter(
      (r) => {
        const after = runtimeDefaultPermission(r, {
          ...current,
          runtimeDefaults: next,
        });
        const before = runtimeDefaultPermission(r, current);
        // Anything that ends in "never asks" and lets agents do MORE than
        // before — the crossing itself, or widening an already never-asks
        // default (e.g. never · read-only → never · danger-full-access).
        return neverAsks(after) && widerAxes(before, after).length > 0;
      },
    );
    if (widened.length > 0 && body.confirmNeverAsks !== true) {
      return c.json(
        {
          error: `The new default for ${widened.join(", ")} never asks before acting. Confirm it (confirmNeverAsks: true) to save.`,
          code: "CONFIRM_NEVER_ASKS",
          runtimes: widened,
        },
        400,
      );
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

  // After the save, outside its try: the file is written either way, and the
  // watcher never throws (it reports its own failures).
  if (partial.runtimeDefaults !== undefined)
    noteRuntimeDefaults(updated, "api");

  // Invalidate usage cache so a credential change takes effect immediately.
  if (
    partial.claudeSessionKey ||
    partial.autoDetectClaudeAccount !== undefined
  ) {
    invalidateCache();
  }

  return c.json(maskSettings(updated));
});
