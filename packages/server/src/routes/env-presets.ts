/**
 * REST API for env presets (~/.autonomos/env-presets/<name>.json).
 *
 * This is the HUMAN surface (the dashboard Presets tab). Unlike the MCP tools
 * (agent surface), PUT/POST here MAY set secret values — this is where the
 * human pastes the API key. All reads are masked by the storage layer
 * (createEnvPreset/updateEnvPreset/getEnvPreset/listEnvPresets all return the
 * masked form). See ADR-067.
 */

import type { Provider } from "@autonomos/core";
import { Hono } from "hono";
import {
  createEnvPreset,
  deleteEnvPreset,
  getEnvPreset,
  listEnvPresets,
  updateEnvPreset,
} from "../envPresets.js";

export const envPresetRouter = new Hono();

const PROVIDERS = new Set<Provider>(["claude-code", "codex", "gemini-cli"]);

function asProvider(v: unknown): Provider | undefined {
  return typeof v === "string" && PROVIDERS.has(v as Provider)
    ? (v as Provider)
    : undefined;
}

function asStringRecord(v: unknown): Record<string, string> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string")
    ? (v as string[])
    : undefined;
}

envPresetRouter.get("/", (c) => {
  try {
    return c.json(listEnvPresets());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Failed to list presets: ${message}` }, 500);
  }
});

envPresetRouter.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.name !== "string" || !body.name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  try {
    const preset = createEnvPreset(
      {
        name: body.name,
        description:
          typeof body.description === "string" ? body.description : undefined,
        provider: asProvider(body.provider),
        label: typeof body.label === "string" ? body.label : undefined,
        env: asStringRecord(body.env),
        secretKeys: asStringArray(body.secretKeys),
        secrets: asStringRecord(body.secrets),
      },
      Date.now(),
    );
    return c.json(preset, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = /already exists|Invalid|Reserved|Blocked/.test(message)
      ? 400
      : 500;
    return c.json({ error: message }, status);
  }
});

envPresetRouter.get("/:name", (c) => {
  const name = c.req.param("name");
  try {
    const preset = getEnvPreset(name);
    if (!preset) return c.json({ error: `Preset "${name}" not found` }, 404);
    return c.json(preset);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json(
      { error: message },
      message.includes("Invalid preset name") ? 400 : 500,
    );
  }
});

envPresetRouter.put("/:name", async (c) => {
  const name = c.req.param("name");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const preset = updateEnvPreset(
      name,
      {
        description:
          typeof body.description === "string" ? body.description : undefined,
        provider: asProvider(body.provider),
        label: typeof body.label === "string" ? body.label : undefined,
        env: asStringRecord(body.env),
        secretKeys: asStringArray(body.secretKeys),
        secrets: asStringRecord(body.secrets),
      },
      Date.now(),
    );
    return c.json(preset);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    let status: 400 | 404 | 500 = 500;
    if (/not found/.test(message)) status = 404;
    else if (/Invalid|Reserved|Blocked/.test(message)) status = 400;
    return c.json({ error: message }, status);
  }
});

envPresetRouter.delete("/:name", (c) => {
  const name = c.req.param("name");
  try {
    const removed = deleteEnvPreset(name);
    if (!removed) return c.json({ error: `Preset "${name}" not found` }, 404);
    return c.json({ ok: true, message: `Preset "${name}" deleted` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Failed to delete preset: ${message}` }, 500);
  }
});
