/**
 * REST API routes for org chart and templates.
 *
 * Org chart is derived from persisted session metadata (manager field).
 * Templates are read from ~/.autonomos/templates/*.json.
 */

import type { AgentCapability } from "@autonomos/core";
import { Hono } from "hono";
import { buildOrgChart } from "../orgChart.js";
import { updatePersistedSessionByName } from "../persisted.js";
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
} from "../templates.js";

export const orgRouter = new Hono();
export const templateRouter = new Hono();

// ── Org Chart ───────────────────────────────────────────────────

orgRouter.get("/", (c) => {
  return c.json(buildOrgChart());
});

orgRouter.put("/manager", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const agent = body.agent;
  const manager = body.manager;

  if (typeof agent !== "string") {
    return c.json({ error: "agent is required" }, 400);
  }

  const ok = updatePersistedSessionByName(agent, {
    manager: typeof manager === "string" ? manager : undefined,
  });
  if (!ok) {
    return c.json({ error: `Agent "${agent}" not found` }, 404);
  }

  return c.json({
    ok: true,
    message: manager
      ? `Set ${agent}'s manager to ${manager}`
      : `Removed ${agent}'s manager`,
  });
});

// ── Templates ───────────────────────────────────────────────────

templateRouter.get("/", (c) => {
  try {
    return c.json(listTemplates());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Failed to list templates: ${message}` }, 500);
  }
});

templateRouter.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { name, role, description, systemPrompt } = body;
  if (typeof name !== "string" || !name.trim()) {
    return c.json({ error: "name is required" }, 400);
  }
  if (typeof role !== "string" || !role.trim()) {
    return c.json({ error: "role is required" }, 400);
  }
  if (typeof description !== "string") {
    return c.json({ error: "description is required" }, 400);
  }
  if (typeof systemPrompt !== "string") {
    return c.json({ error: "systemPrompt is required" }, 400);
  }

  try {
    saveTemplate(name, {
      role,
      description,
      systemPrompt,
      capabilities: Array.isArray(body.capabilities)
        ? (body.capabilities.filter(
            (c): c is string => typeof c === "string",
          ) as AgentCapability[])
        : ["send", "list_agents", "create_agent", "kill_agent"],
      autonomousMode:
        typeof body.autonomousMode === "boolean" ? body.autonomousMode : true,
      model: typeof body.model === "string" ? body.model : undefined,
    });
    return c.json({
      ok: true,
      message: `Template "${name}" created`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Failed to create template: ${message}` }, 500);
  }
});

templateRouter.get("/:name", (c) => {
  const name = c.req.param("name");
  try {
    const template = getTemplate(name);
    if (!template) {
      return c.json({ error: `Template "${name}" not found` }, 404);
    }
    return c.json(template);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const status = message.includes("Invalid template name") ? 400 : 500;
    return c.json({ error: message }, status);
  }
});

templateRouter.delete("/:name", (c) => {
  const name = c.req.param("name");
  try {
    const removed = deleteTemplate(name);
    if (!removed) {
      return c.json({ error: `Template "${name}" not found` }, 404);
    }
    return c.json({ ok: true, message: `Template "${name}" deleted` });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Failed to delete template: ${message}` }, 500);
  }
});
