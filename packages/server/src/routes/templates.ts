/**
 * REST API for agent templates (~/.autonomos/templates/<name>.json).
 *
 * Templates are blueprints for agents — role, system prompt, permission mode.
 * Extracted from the legacy routes/hierarchy.ts on the unified-Agent refactor.
 */

import { DEFAULT_PERMISSION_MODE, isPermissionMode } from "@autonomos/core";
import { Hono } from "hono";
import {
  DEPRECATED_CAPABILITIES_NOTE,
  deleteTemplate,
  getTemplate,
  listTemplates,
  saveTemplate,
} from "../templates.js";

export const templateRouter = new Hono();

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
  // Anything accepted-but-ignored goes back to the caller, not just the log.
  // A 200 with `ok: true` on a request that was only partly honored is how a
  // caller ends up believing it configured something it did not — the same
  // defect class ADR-058 removed from the tool layer.
  const warnings: string[] = [];

  const permissionMode = isPermissionMode(body.permissionMode)
    ? body.permissionMode
    : DEFAULT_PERMISSION_MODE;
  if (
    body.permissionMode !== undefined &&
    !isPermissionMode(body.permissionMode)
  ) {
    const note = `Invalid permissionMode ${JSON.stringify(body.permissionMode)} ignored — using "${DEFAULT_PERMISSION_MODE}".`;
    warnings.push(note);
    console.warn(`[api/templates] ${note}`);
  }

  // Agents spawned before ADR-058 still hold the OLD create_template schema in
  // their context and will keep sending `capabilities` for as long as they run.
  if ("capabilities" in body) {
    warnings.push(DEPRECATED_CAPABILITIES_NOTE);
    console.warn(
      `[api/templates] ignoring deprecated 'capabilities' on "${name}"`,
    );
  }

  try {
    saveTemplate(name, {
      role,
      description,
      systemPrompt,
      permissionMode,
      model: typeof body.model === "string" ? body.model : undefined,
    });
    return c.json({
      ok: true,
      message: `Template "${name}" created`,
      ...(warnings.length ? { warnings } : {}),
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
