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
    // Reparent children with best-effort rollback. We commit per-child
    // (no transaction against the file store), so on failure we walk
    // already-reparented children in reverse and restore each one to
    // its original managerId.
    //
    // Two changes vs naive:
    //
    // 1. EVENTS BUFFERED. agent.reparented deltas are queued, not emitted,
    //    until the whole loop succeeds. WS clients (HierarchyPanel) would
    //    otherwise see N forward moves followed by N reverse moves on
    //    rollback — visible flicker, possibly missed events on a coalescing
    //    client. Net state is unchanged for clients on rollback, so
    //    emitting nothing is correct.
    //
    // 2. STATUS CODE distinguishes clean rollback (409 — caller can retry)
    //    from rollback that itself partially failed (500 — tree is in
    //    inconsistent state, manual operator action required, do NOT retry).
    //
    // 3. setManager calls in the rollback loop are wrapped in try/catch.
    //    writeAgentFile throws on lastReadFailed; without the wrap, a
    //    transient FS error mid-rollback would short-circuit past the
    //    structured response and crash the handler with a generic 500.
    const originalManagers = new Map(children.map((c) => [c.id, c.managerId]));
    const reparented: { id: UUID; name: string }[] = [];
    // Forward deltas keyed by id so we can selectively emit them on
    // rollback-failure (children whose forward write succeeded but whose
    // rollback failed need the FORWARD delta so WS clients converge to
    // the actual disk state — they're stuck under newParent).
    const pendingDeltas = new Map<UUID, Parameters<typeof emitAgentDelta>[0]>();
    for (const child of children) {
      // setManager → writeAgentFile is throw-capable on lastReadFailed
      // (per the store's cache/disk-divergence guard). Wrap it so the
      // existing failure branch handles throws too — without this, a
      // mid-loop throw bypasses the structured rollback path entirely
      // and the handler crashes to a generic 500 with the disk already
      // mutated and pendingDeltas un-flushed.
      let updated: ReturnType<typeof setManager>;
      try {
        updated = setManager(child.id, newParent);
      } catch (forwardErr) {
        console.error(
          `[agents] DELETE setManager THREW for ${child.id} (${child.name}): ${forwardErr instanceof Error ? forwardErr.message : forwardErr}`,
        );
        // updated stays undefined — falls into the rollback branch below.
      }
      if (typeof updated === "string" || updated === undefined) {
        // Rollback path — buffered forward deltas are dropped (never emitted).
        const rollbackFailures: { id: UUID; name: string; reason: string }[] =
          [];
        for (const r of [...reparented].reverse()) {
          const orig = originalManagers.get(r.id) ?? null;
          let restored: ReturnType<typeof setManager>;
          let threw = false;
          try {
            restored = setManager(r.id, orig);
          } catch (rollbackErr) {
            // writeAgentFile may throw on lastReadFailed mid-rollback.
            // Treat the throw the same as restored===undefined so the
            // structured response still gets produced rather than crashing
            // the handler with a generic 500.
            console.error(
              `[agents] DELETE rollback THREW for ${r.id} (${r.name}): ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`,
            );
            threw = true;
          }
          const failureReason: string | null = threw
            ? "throw"
            : typeof restored === "string"
              ? restored
              : restored === undefined
                ? "not-found"
                : null;
          if (failureReason !== null) {
            rollbackFailures.push({
              id: r.id,
              name: r.name,
              reason: failureReason,
            });
            console.error(
              `[agents] DELETE rollback FAILED for ${r.id} (${r.name}) — child remains under newParent (${failureReason})`,
            );
            // Disk is still under newParent for this child. Emit the
            // FORWARD delta so WS clients converge to actual disk state,
            // rather than staying stuck on stale "under original parent"
            // until they reconnect-and-reconcile. The 500 response tells
            // the operator to act; the delta keeps the dashboard honest.
            const forwardDelta = pendingDeltas.get(r.id);
            if (forwardDelta) emitAgentDelta(forwardDelta);
          } else if (restored && typeof restored !== "string") {
            // Rollback succeeded for this child — emit the reparent-back
            // event so clients converge to the correct state.
            emitAgentDelta({
              type: "agent.reparented",
              id: restored.id,
              managerId: restored.managerId,
              version: restored.version,
            });
          }
        }
        const rolledBackOk = reparented.filter(
          (r) => !rollbackFailures.some((f) => f.id === r.id),
        );
        const cleanRollback = rollbackFailures.length === 0;
        return c.json(
          {
            error: cleanRollback
              ? `Aborted: setManager(${child.id}) returned ${updated ?? "not-found"}. All previously-reparented children were rolled back. Agent NOT deleted; safe to retry.`
              : `Aborted: setManager(${child.id}) returned ${updated ?? "not-found"} AND ${rollbackFailures.length} rollback step(s) failed. Tree IS in inconsistent state — DO NOT retry; manual reconciliation required (see rollbackFailures).`,
            failedAt: {
              id: child.id,
              name: child.name,
              reason: updated ?? "not-found",
            },
            rolledBack: rolledBackOk,
            rollbackFailures,
          },
          // 409 only when caller can safely retry (clean rollback);
          // 500 when the tree is left mutated and retrying would compound.
          cleanRollback ? 409 : 500,
        );
      }
      pendingDeltas.set(child.id, {
        type: "agent.reparented",
        id: updated.id,
        managerId: updated.managerId,
        version: updated.version,
      });
      reparented.push({ id: child.id, name: child.name });
    }
    // All reparents succeeded — flush buffered deltas to clients.
    for (const delta of pendingDeltas.values()) emitAgentDelta(delta);
  }

  // Kill PTY if attached, then delete record + emit. Distinguish "the agent
  // is now gone" (desired post-state achieved — return 200) from "we tried
  // to delete and failed" (real fs error — return 500). Two paths land at
  // both-returned-false: (a) benign race where another caller deleted it
  // between our GET-check and the call (file is now ENOENT, both deletes
  // legitimately return false), and (b) the unlink genuinely failed.
  // Re-checking `getAgent(id)` distinguishes them.
  const removed = runtimeDeleteAgent(id);
  if (!removed) {
    const rawRemoved = deleteAgentRaw(id);
    if (!rawRemoved && getAgent(id) !== undefined) {
      console.error(
        `[agents] DELETE /:id ${id} — both removes returned false AND record still in store (real filesystem error)`,
      );
      return c.json(
        { error: `Failed to delete agent "${id}" — see server logs` },
        500,
      );
    }
    // Else: agent is genuinely gone (race resolved itself) — fall through to 200.
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
