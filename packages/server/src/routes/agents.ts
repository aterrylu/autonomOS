/**
 * REST API for the unified Agent collection.
 *
 * Replaces /api/sessions and /api/org. Both flat-list and hierarchy-tree
 * views on the dashboard derive their shape from the same payload, so they
 * cannot disagree about what exists.
 */

import type { Provider, UUID } from "@autonomos/core";
import { Hono } from "hono";
import {
  killAttachment,
  deleteAgent as runtimeDeleteAgent,
  spawnAgent,
} from "../agents/runtime.js";
import {
  buildAgentTree,
  childrenOf,
  deleteAgentRaw,
  getAgent,
  listAgents,
  patchAgent,
  resolveAgent,
  resolveAgentByName,
  setManager,
} from "../agents/store.js";
import { emitAgentDelta } from "../events/agents.js";
import { getTemplate } from "../templates.js";

export const agentsRouter = new Hono();

// ── Read ───────────────────────────────────────────────────────────

agentsRouter.get("/", (c) => {
  return c.json(listAgents());
});

/** Node shape returned by `/api/agents/tree`. The `claudeSessionId` alias
 *  is kept for dashboard-side compatibility with the legacy OrgNode shape
 *  that pre-dates the Agent/Session merger. */
interface AgentTreeApiNode {
  id: string;
  claudeSessionId: string;
  name: string;
  template?: string;
  project?: string;
  status: string;
  children: AgentTreeApiNode[];
}

// Tree-shape variant for clients that can't build the tree themselves
// (e.g. external MCP clients). Same data, just nested by managerId.
agentsRouter.get("/tree", (c) => {
  const includeExited = c.req.query("includeExited") === "true";
  const tree = buildAgentTree<AgentTreeApiNode>({
    includeExited,
    mapNode: (a) => ({
      id: a.id,
      claudeSessionId: a.id,
      name: a.name,
      template: a.template,
      project: a.project,
      status: a.status,
    }),
  });
  return c.json(tree);
});

agentsRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  const agent = resolveAgent(id);
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

  // Resolve manager — accept either managerId (UUID) or manager (name).
  // Name takes precedence if both supplied since MCP/UI surfaces use names.
  let managerId: UUID | null = null;
  if (typeof body.manager === "string" && body.manager.length > 0) {
    const mgr = resolveAgentByName(body.manager);
    if (!mgr) {
      return c.json({ error: `Manager "${body.manager}" not found` }, 400);
    }
    managerId = mgr.id;
  } else if (typeof body.managerId === "string") {
    if (!getAgent(body.managerId)) {
      return c.json({ error: `managerId "${body.managerId}" not found` }, 400);
    }
    managerId = body.managerId;
  }

  const systemPrompt =
    typeof body.appendSystemPrompt === "string"
      ? body.appendSystemPrompt
      : tmpl?.systemPrompt;
  const autonomousMode = (body.autonomousMode ?? tmpl?.autonomousMode) === true;

  try {
    const result = spawnAgent({
      workingDirectory: body.workingDirectory,
      name: typeof body.name === "string" ? body.name : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      resumeAgentId:
        typeof body.resumeAgentId === "string" ? body.resumeAgentId : undefined,
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
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);

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

  const result = patchAgent(agent.id, patch, versionNumber);
  if (result === undefined) {
    return c.json({ error: `Agent "${param}" not found` }, 404);
  }
  if (result === "stale") {
    return c.json(
      {
        error: "Version mismatch — refresh and retry",
        currentVersion: getAgent(agent.id)?.version,
      },
      409,
    );
  }
  emitAgentDelta({
    type: "agent.updated",
    id: result.id,
    patch,
    version: result.version,
  });
  return c.json(result);
});

// ── Set manager ────────────────────────────────────────────────────

agentsRouter.post("/:id/manager", async (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  // Accept either managerId (UUID) or manager (name). Null/undefined clears.
  let managerId: UUID | null;
  if (typeof body.manager === "string" && body.manager.length > 0) {
    const mgr = resolveAgentByName(body.manager);
    if (!mgr) {
      return c.json({ error: `Manager "${body.manager}" not found` }, 404);
    }
    managerId = mgr.id;
  } else if (body.managerId === null || body.managerId === undefined) {
    managerId = null;
  } else if (typeof body.managerId === "string") {
    managerId = body.managerId;
  } else {
    return c.json({ error: "managerId must be string or null" }, 400);
  }

  const expectedVersion =
    typeof body.version === "number" ? body.version : undefined;

  const result = setManager(agent.id, managerId, expectedVersion);
  if (result === undefined) {
    return c.json({ error: `Agent "${param}" or managerId not found` }, 404);
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
        currentVersion: getAgent(agent.id)?.version,
      },
      409,
    );
  }
  emitAgentDelta({
    type: "agent.reparented",
    id: result.id,
    managerId: result.managerId,
    version: result.version,
  });
  return c.json(result);
});

// ── Attach (resume) ────────────────────────────────────────────────

agentsRouter.post("/:id/attach", (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);

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
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);
  const id = agent.id;

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
    // Reparent children, collecting any failure. We commit per-child (no
    // transaction available against the file store), so on the first failure
    // we abort and surface a 409 with what succeeded — leaving a clear
    // partial-state signal rather than silently dropping children.
    const reparented: { id: UUID; name: string }[] = [];
    for (const child of children) {
      const updated = setManager(child.id, newParent);
      if (typeof updated === "string" || updated === undefined) {
        return c.json(
          {
            error: `Aborted partway: setManager(${child.id}) returned ${updated ?? "not-found"}. ${reparented.length} child(ren) already reparented; ${children.length - reparented.length} remaining; agent NOT deleted.`,
            reparented,
            failedAt: {
              id: child.id,
              name: child.name,
              reason: updated ?? "not-found",
            },
          },
          409,
        );
      }
      emitAgentDelta({
        type: "agent.reparented",
        id: updated.id,
        managerId: updated.managerId,
        version: updated.version,
      });
      reparented.push({ id: child.id, name: child.name });
    }
  }

  // Kill PTY if attached, then delete record + emit. Surface real failure
  // rather than silently 200ing — silent success after a filesystem error
  // makes "why is this agent still here?" very hard to debug.
  const removed = runtimeDeleteAgent(id);
  if (!removed) {
    // Race: agent vanished between the check and the call, OR the file
    // remove genuinely failed. Try one more raw-delete; if THAT fails, surface.
    const rawRemoved = deleteAgentRaw(id);
    if (!rawRemoved) {
      console.error(
        `[agents] DELETE /:id ${id} — runtime delete returned false AND deleteAgentRaw returned false (filesystem error?)`,
      );
      return c.json(
        { error: `Failed to delete agent "${id}" — see server logs` },
        500,
      );
    }
  }
  return c.json({ ok: true, id });
});

// ── Kill (PTY only, keep agent record) ─────────────────────────────

agentsRouter.post("/:id/kill", (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);
  const killed = killAttachment(agent.id);
  if (!killed) {
    return c.json(
      { error: `Agent "${param}" has no live attachment to kill` },
      409,
    );
  }
  return c.json({ ok: true, id: agent.id });
});
