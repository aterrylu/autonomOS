/**
 * REST API for the unified Agent collection.
 *
 * Replaces /api/sessions and /api/org. Both flat-list and hierarchy-tree
 * views on the dashboard derive their shape from the same payload, so they
 * cannot disagree about what exists.
 */

import { Hono } from "hono";
import type { Provider, UUID } from "@autonomos/core";
import {
  childrenOf,
  deleteAgentRaw,
  getAgent,
  listAgents,
  patchAgent,
  resolveAgent,
  setManager,
} from "../agents/store.js";
import {
  deleteAgent as runtimeDeleteAgent,
  killAttachment,
  spawnAgent,
} from "../agents/runtime.js";
import { emitAgentEvent } from "../events/agents.js";
import { getTemplate } from "../templates.js";

export const agentsRouter = new Hono();

// ── Read ───────────────────────────────────────────────────────────

agentsRouter.get("/", (c) => {
  return c.json(listAgents());
});

agentsRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  const agent = getAgent(id) ?? resolveAgent(id);
  if (!agent) return c.json({ error: `Agent "${id}" not found` }, 404);
  return c.json(agent);
});

// ── Create ─────────────────────────────────────────────────────────

agentsRouter.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.workingDirectory || typeof body.workingDirectory !== "string") {
    return c.json({ error: "workingDirectory is required" }, 400);
  }

  // Resolve template if provided
  const templateName =
    typeof body.template === "string" ? body.template : undefined;
  const tmpl = templateName ? getTemplate(templateName) : null;
  if (templateName && !tmpl) {
    return c.json({ error: `Template "${templateName}" not found` }, 400);
  }

  // Resolve manager (if provided as id; name resolution lives at MCP layer)
  let managerId: UUID | null = null;
  if (typeof body.managerId === "string") {
    if (!getAgent(body.managerId)) {
      return c.json(
        { error: `managerId "${body.managerId}" not found` },
        400,
      );
    }
    managerId = body.managerId;
  }

  const systemPrompt =
    typeof body.appendSystemPrompt === "string"
      ? body.appendSystemPrompt
      : tmpl?.systemPrompt;
  const autonomousMode =
    (body.autonomousMode ?? tmpl?.autonomousMode) === true;

  try {
    const result = spawnAgent({
      workingDirectory: body.workingDirectory,
      name: typeof body.name === "string" ? body.name : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      resumeAgentId:
        typeof body.resumeAgentId === "string"
          ? body.resumeAgentId
          : undefined,
      forkFromAgentId:
        typeof body.forkFromAgentId === "string"
          ? body.forkFromAgentId
          : undefined,
      autonomousMode,
      appendSystemPrompt: systemPrompt,
      template: templateName,
      managerId,
      project: typeof body.project === "string" ? body.project : undefined,
      cols: typeof body.cols === "number" ? body.cols : undefined,
      rows: typeof body.rows === "number" ? body.rows : undefined,
      provider:
        typeof body.provider === "string"
          ? (body.provider as Provider)
          : undefined,
    });
    return c.json(result.agent, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("already running")) {
      return c.json({ error: message }, 409);
    }
    if (message.includes("not found")) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 500);
  }
});

// ── Patch (rename / template / project) ────────────────────────────

agentsRouter.patch("/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const expectedVersion = c.req.header("If-Match");
  const versionNumber = expectedVersion
    ? Number.parseInt(expectedVersion, 10)
    : undefined;

  const patch: Parameters<typeof patchAgent>[1] = {};
  if (typeof body.name === "string") patch.name = body.name;
  if (typeof body.template === "string") patch.template = body.template;
  if (typeof body.project === "string") patch.project = body.project;
  if (typeof body.autonomousMode === "boolean")
    patch.autonomousMode = body.autonomousMode;

  const result = patchAgent(id, patch, versionNumber);
  if (result === undefined) {
    return c.json({ error: `Agent "${id}" not found` }, 404);
  }
  if (result === "stale") {
    return c.json(
      {
        error: "Version mismatch — refresh and retry",
        currentVersion: getAgent(id)?.version,
      },
      409,
    );
  }
  emitAgentEvent({
    type: "agent.updated",
    id: result.id,
    patch,
    version: result.version,
  });
  return c.json(result);
});

// ── Set manager ────────────────────────────────────────────────────

agentsRouter.post("/:id/manager", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Allow null to clear
  let managerId: UUID | null;
  if (body.managerId === null || body.managerId === undefined) {
    managerId = null;
  } else if (typeof body.managerId === "string") {
    managerId = body.managerId;
  } else {
    return c.json({ error: "managerId must be string or null" }, 400);
  }

  const expectedVersion =
    typeof body.version === "number" ? body.version : undefined;

  const result = setManager(id, managerId, expectedVersion);
  if (result === undefined) {
    return c.json(
      { error: `Agent "${id}" or managerId not found` },
      404,
    );
  }
  if (result === "cycle") {
    return c.json(
      { error: "Cycle: the proposed manager is a descendant of this agent" },
      409,
    );
  }
  if (result === "stale") {
    return c.json(
      {
        error: "Version mismatch — refresh and retry",
        currentVersion: getAgent(id)?.version,
      },
      409,
    );
  }
  emitAgentEvent({
    type: "agent.reparented",
    id: result.id,
    managerId: result.managerId,
    version: result.version,
  });
  return c.json(result);
});

// ── Attach (resume) ────────────────────────────────────────────────

agentsRouter.post("/:id/attach", (c) => {
  const id = c.req.param("id");
  const agent = getAgent(id);
  if (!agent) return c.json({ error: `Agent "${id}" not found` }, 404);

  try {
    const result = spawnAgent({
      workingDirectory: agent.workingDirectory,
      resumeAgentId: agent.id,
      name: agent.name,
      autonomousMode: agent.autonomousMode,
      template: agent.template,
      managerId: agent.managerId,
      project: agent.project,
      provider: agent.provider,
    });
    return c.json(result.agent);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("already attached")) {
      return c.json({ error: message }, 409);
    }
    return c.json({ error: message }, 500);
  }
});

// ── Delete ─────────────────────────────────────────────────────────
//
// Default: hard delete, but 409 if children exist.
// ?reassignTo=<uuid|null>  — transactionally reassign children, then delete.
// ?force=true              — orphan children to root, then delete.

agentsRouter.delete("/:id", (c) => {
  const id = c.req.param("id");
  const agent = getAgent(id);
  if (!agent) return c.json({ error: `Agent "${id}" not found` }, 404);

  const reassignTo = c.req.query("reassignTo");
  const force = c.req.query("force") === "true";
  const children = childrenOf(id);

  if (children.length > 0) {
    if (reassignTo === undefined && !force) {
      return c.json(
        {
          error: `Agent has ${children.length} child(ren). Pass ?reassignTo=<uuid|null> or ?force=true.`,
          children: children.map((c) => ({ id: c.id, name: c.name })),
        },
        409,
      );
    }
    let newParent: UUID | null = null;
    if (reassignTo !== undefined && reassignTo !== "null") {
      if (!getAgent(reassignTo)) {
        return c.json(
          { error: `reassignTo target "${reassignTo}" not found` },
          400,
        );
      }
      newParent = reassignTo;
    }
    for (const child of children) {
      const updated = setManager(child.id, newParent);
      if (updated && typeof updated !== "string") {
        emitAgentEvent({
          type: "agent.reparented",
          id: updated.id,
          managerId: updated.managerId,
          version: updated.version,
        });
      }
    }
  }

  // Kill PTY if attached, then delete record + emit
  const removed = runtimeDeleteAgent(id);
  if (!removed) {
    // Race: agent vanished between the check and the call. Treat as success.
    deleteAgentRaw(id);
  }
  return c.json({ ok: true, id });
});

// ── Kill (PTY only, keep agent record) ─────────────────────────────

agentsRouter.post("/:id/kill", (c) => {
  const id = c.req.param("id");
  const agent = getAgent(id);
  if (!agent) return c.json({ error: `Agent "${id}" not found` }, 404);
  const killed = killAttachment(id);
  if (!killed) {
    return c.json(
      { error: `Agent "${id}" has no live attachment to kill` },
      409,
    );
  }
  return c.json({ ok: true, id });
});
