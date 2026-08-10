/**
 * REST API for env presets (~/.autonomos/env-presets/<name>.json).
 *
 * This is the HUMAN surface (the dashboard Presets tab). Unlike the MCP tools
 * (agent surface), PUT/POST here MAY set secret values — this is where the
 * human pastes the API key, and the ONLY place that passes `writeSecrets` to
 * the store (which strips secret values by default). All reads are masked by
 * the storage layer (createEnvPreset/updateEnvPreset/getEnvPreset/listEnvPresets
 * all return the masked form). See ADR-067.
 */

import { Hono } from "hono";
import {
  createEnvPreset,
  deleteEnvPreset,
  getEnvPreset,
  listEnvPresets,
  updateEnvPreset,
} from "../envPresets.js";
import {
  parseBody,
  restCreateEnvPresetSchema,
  restUpdateEnvPresetSchema,
} from "../validation.js";

export const envPresetRouter = new Hono();

/** The human write path — see the module note. */
const HUMAN_WRITE = { writeSecrets: true } as const;

envPresetRouter.get("/", (c) => {
  try {
    return c.json(listEnvPresets());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Failed to list presets: ${message}` }, 500);
  }
});

envPresetRouter.post("/", async (c) => {
  const body = await parseBody(c, restCreateEnvPresetSchema);
  try {
    const preset = createEnvPreset(body, Date.now(), HUMAN_WRITE);
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
  const body = await parseBody(c, restUpdateEnvPresetSchema);
  try {
    const preset = updateEnvPreset(name, body, Date.now(), HUMAN_WRITE);
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
