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
  restartAllAttachments,
  deleteAgent as runtimeDeleteAgent,
  spawnAgent,
} from "../agents/runtime.js";
import {
  buildAgentTree,
  CachePoisonedError,
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
import { recordEvent } from "../memory/events.js";
import { getTemplate } from "../templates.js";

export const agentsRouter = new Hono();

// Map cache-poisoned writes to a stable 503 across the whole agents
// surface. Without this, every patchAgent / setManager / insertAgent
// caller (PATCH /api/agents/:id, PUT /:id/manager, POST /, MCP tools
// reaching the same store, etc.) would bubble a generic 500 with only
// a stack in logs — clients can't distinguish "transient miss, retry"
// from "server's view of disk is broken, retrying is pointless until
// the operator restarts." 503 + stable error code = explicit signal.
//
// The DELETE handler still catches the throw locally because it has
// in-flight reparent state (pendingDeltas) that needs to be flushed
// to keep WS clients in sync with disk before the response goes out.
// This onError covers the simpler routes that don't have that.
agentsRouter.onError((err, c) => {
  if (err instanceof CachePoisonedError) {
    console.error(`[agents] CACHE_POISONED on ${c.req.method} ${c.req.path}`);
    return c.json(
      {
        error: err.message,
        code: err.code,
        retryable: false,
      },
      503,
    );
  }
  // For any other error, log it and return an explicit 500 response
  // (rather than `throw err` which relies on undocumented Hono behavior
  // — depending on version, a re-throw from onError can surface as an
  // unhandled rejection or connection drop instead of the structured
  // 500 the operator expects). The logged stack is the canonical
  // record; the response carries enough context for the dashboard.
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `[agents] unhandled ${err instanceof Error ? err.name : "error"} on ${c.req.method} ${c.req.path}: ${message}`,
    err instanceof Error ? err.stack : undefined,
  );
  return c.json({ error: message }, 500);
});

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
  provider: string;
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
      provider: a.provider,
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
    const result = await spawnAgent({
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
    recordEvent({
      type: "agent_created",
      actorAgentId: result.agent.id,
      summary: `created agent ${result.agent.name}${
        result.agent.template ? ` (template: ${result.agent.template})` : ""
      }`,
      project: result.agent.project ?? null,
      payload: {
        agentId: result.agent.id,
        name: result.agent.name,
        template: result.agent.template,
        workingDirectory: result.agent.workingDirectory,
        managerId: result.agent.managerId,
      },
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
  recordEvent({
    type: "manager_set",
    actorAgentId: result.id,
    summary: `${result.name} → manager=${managerId ?? "(cleared)"}`,
    project: result.project ?? null,
    refs: managerId ? { agentIds: [managerId] } : undefined,
    payload: { agentId: result.id, managerId },
  });
  return c.json(result);
});

// ── Attach (resume) ────────────────────────────────────────────────

agentsRouter.post("/:id/attach", async (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);

  try {
    const result = await spawnAgent({
      workingDirectory: agent.workingDirectory,
      resumeAgentId: agent.id,
      name: agent.name,
      autonomousMode: agent.autonomousMode,
      template: agent.template,
      managerId: agent.managerId,
      project: agent.project,
      provider: agent.provider,
    });
    recordEvent({
      type: "agent_resumed",
      actorAgentId: result.agent.id,
      summary: `resumed agent ${result.agent.name}`,
      project: result.agent.project ?? null,
      payload: { agentId: result.agent.id, name: result.agent.name },
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

  // Lifted to handler scope so the post-delete code path can flush deltas
  // / inspect reparent state regardless of whether children existed.
  // Forward deltas keyed by id — they reflect changes already persisted
  // to disk, but are NOT broadcast until the delete itself confirms. If
  // the delete then fails (parent still on disk), we still emit the
  // forward deltas so WS clients converge to actual disk state, even
  // though the original goal (delete) didn't complete.
  const pendingDeltas = new Map<UUID, Parameters<typeof emitAgentDelta>[0]>();
  const reparented: { id: UUID; name: string }[] = [];
  let originalManagers = new Map<UUID, UUID | null>();

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
    originalManagers = new Map(children.map((c) => [c.id, c.managerId]));
    for (const child of children) {
      // setManager → writeAgentFile is throw-capable on lastReadFailed
      // (per the store's cache/disk-divergence guard). Wrap it so the
      // existing failure branch handles throws too — without this, a
      // mid-loop throw bypasses the structured rollback path entirely
      // and the handler crashes to a generic 500 with the disk already
      // mutated and pendingDeltas un-flushed.
      let updated: ReturnType<typeof setManager>;
      let forwardThrew = false;
      let forwardErrorMessage: string | null = null;
      // Track CachePoisonedError separately from generic throws — it has
      // different semantics (persistent server degradation, NOT safe to
      // retry until restart) and the response must escalate to 503 with
      // CACHE_POISONED code to match the contract enforced by the
      // runtimeDeleteAgent / deleteAgentRaw / router-onError paths in
      // this same handler.
      let cachePoisonedErr: CachePoisonedError | null = null;
      try {
        updated = setManager(child.id, newParent);
      } catch (forwardErr) {
        forwardErrorMessage =
          forwardErr instanceof Error ? forwardErr.message : String(forwardErr);
        console.error(
          `[agents] DELETE setManager THREW for ${child.id} (${child.name}): ${forwardErrorMessage}`,
        );
        forwardThrew = true;
        if (forwardErr instanceof CachePoisonedError) {
          cachePoisonedErr = forwardErr;
        }
        // updated stays undefined — falls into the rollback branch below.
      }
      if (typeof updated === "string" || updated === undefined) {
        // Hoisted: forwardReason is computed once and reused by both the
        // CachePoisonedError branches AND the regular 409/500 path below.
        // Previously each branch re-derived it (or hardcoded "throw"),
        // which silently misattributed forward "cycle"/"not-found"
        // failures as throws when the rollback hit CachePoisonedError.
        const forwardReason: string = forwardThrew
          ? "throw"
          : typeof updated === "string"
            ? updated
            : "not-found";
        // Fast path: forward CachePoisonedError. Every rollback iteration
        // would just throw CachePoisonedError too (writeAgentFile checks
        // lastReadFailed unconditionally). Skip the rollback loop, flush
        // pendingDeltas (prior reparents already persisted to disk), and
        // return 503 with the standard CachePoisonedError envelope PLUS
        // the failedAt structure every other DELETE error response uses,
        // so clients have one shape to parse regardless of failure mode.
        if (cachePoisonedErr) {
          for (const d of pendingDeltas.values()) emitAgentDelta(d);
          return c.json(
            {
              error: cachePoisonedErr.message,
              code: cachePoisonedErr.code,
              retryable: false,
              failedAt: {
                id: child.id,
                name: child.name,
                reason: forwardReason,
                ...(forwardErrorMessage !== null && {
                  message: forwardErrorMessage,
                }),
              },
              ...(reparented.length > 0 && { reparented }),
            },
            503,
          );
        }
        // Rollback path — buffered forward deltas are dropped (never emitted).
        const rollbackFailures: {
          id: UUID;
          name: string;
          reason: string;
          message?: string;
        }[] = [];
        for (const r of [...reparented].reverse()) {
          const orig = originalManagers.get(r.id) ?? null;
          let restored: ReturnType<typeof setManager>;
          let threw = false;
          let rollbackErrorMessage: string | null = null;
          try {
            restored = setManager(r.id, orig);
          } catch (rollbackErr) {
            // writeAgentFile may throw on lastReadFailed mid-rollback.
            // Treat the throw the same as restored===undefined so the
            // structured response still gets produced rather than crashing
            // the handler with a generic 500.
            rollbackErrorMessage =
              rollbackErr instanceof Error
                ? rollbackErr.message
                : String(rollbackErr);
            console.error(
              `[agents] DELETE rollback THREW for ${r.id} (${r.name}): ${rollbackErrorMessage}`,
            );
            threw = true;
            // CachePoisonedError mid-rollback signals all subsequent
            // setManager calls will throw the same way. We don't abort
            // the loop (each remaining iteration's predictable throw
            // correctly flushes its forward delta below), but we DO
            // record the first occurrence so the post-loop response
            // escalates to 503 instead of 500.
            if (
              rollbackErr instanceof CachePoisonedError &&
              !cachePoisonedErr
            ) {
              cachePoisonedErr = rollbackErr;
            }
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
              ...(rollbackErrorMessage !== null && {
                message: rollbackErrorMessage,
              }),
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
        // Cache-poisoned during rollback → escalate to 503. Cannot be a
        // 500 because the response code carries a contract: 500 means
        // "transient, try again," 503 + CACHE_POISONED means "server's
        // view of disk is broken; restart the server, retry is pointless."
        // Forward deltas were already emitted per-iteration in the loop
        // above for each failed rollback (every iter throws CachePoisonedError
        // here, so every iter went through the failure branch and flushed
        // its forward delta). We don't re-flush.
        if (cachePoisonedErr) {
          return c.json(
            {
              error: cachePoisonedErr.message,
              code: cachePoisonedErr.code,
              retryable: false,
              // Use the hoisted forwardReason (computed once at the top
              // of this branch) instead of hardcoding "throw" — the
              // forward could have returned "cycle"/"not-found" cleanly
              // and only the rollback hit CachePoisonedError. Hardcoding
              // "throw" here misattributes those forward failure modes
              // as transient FS errors, contradicting the actual cause.
              // Caller's error message remains the rollback-poison cause
              // (cachePoisonedErr.message); failedAt.message reports the
              // distinct forward error if there was one.
              failedAt: {
                id: child.id,
                name: child.name,
                reason: forwardReason,
                ...(forwardErrorMessage !== null && {
                  message: forwardErrorMessage,
                }),
              },
              rolledBack: rolledBackOk,
              rollbackFailures,
            },
            503,
          );
        }
        // Retry hint is conditional on the forward reason — only "throw"
        // is plausibly transient (FS hiccup) and safe to retry with the
        // same args. "cycle" and "not-found" are deterministic given the
        // requested reassignTo target, so retrying without changing
        // arguments would just re-fail the same way.
        const retryHint = cleanRollback
          ? forwardReason === "throw"
            ? "Likely transient (filesystem error); safe to retry the DELETE with the same args."
            : forwardReason === "cycle"
              ? `Cannot reassign to "${newParent ?? "null"}" — would create a cycle. Choose a different reassignTo target and retry.`
              : // "not-found": the reassignTo target (newParent) was deleted between
                // the pre-check and the loop, OR a child went missing. Re-fetch the
                // tree before retrying.
                `reassignTo target "${newParent ?? "null"}" or child "${child.id}" no longer exists. Refetch the tree, choose a new target, and retry.`
          : "";
        return c.json(
          {
            error: cleanRollback
              ? `Aborted: setManager(${child.id}) returned ${forwardReason}. All previously-reparented children were rolled back. Agent NOT deleted. ${retryHint}`
              : `Aborted: setManager(${child.id}) returned ${forwardReason} AND ${rollbackFailures.length} rollback step(s) failed. Tree IS in inconsistent state — DO NOT retry; manual reconciliation required (see rollbackFailures).`,
            failedAt: {
              id: child.id,
              name: child.name,
              reason: forwardReason,
              ...(forwardErrorMessage !== null && {
                message: forwardErrorMessage,
              }),
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
    // NOTE: reparents have committed to disk, but pendingDeltas are NOT
    // flushed yet. Flush is deferred to after the delete itself confirms,
    // so a delete failure doesn't leave WS clients announcing "children
    // moved away from a parent that still exists" — see post-delete code.
  }

  // Kill PTY if attached, then delete record + emit. Distinguish "the agent
  // is now gone" (desired post-state achieved — return 200) from "we tried
  // to delete and failed" (real fs error — return 500). Two paths land at
  // both-returned-false: (a) benign race where another caller deleted it
  // between our GET-check and the call (file is now ENOENT, both deletes
  // legitimately return false), and (b) the unlink genuinely failed.
  // Re-checking `getAgent(id)` distinguishes them.
  //
  // runtimeDeleteAgent itself can THROW synchronously: pty.kill is caught
  // internally, but deleteAgentRaw → unlinkSync can throw on EPERM/EBUSY,
  // and emitAgentDelta can throw if a listener throws. Without the catch,
  // those bypass the post-delete code entirely and the buffered reparent
  // deltas are never flushed — disk shows children moved while WS clients
  // see them under the still-existing parent. Catch, flush deltas (so WS
  // state matches actual disk), then either re-throw CachePoisonedError
  // (router onError maps it to 503) or return 500 with the same shape
  // the inner branch produces.
  let removed: boolean;
  try {
    removed = runtimeDeleteAgent(id);
  } catch (deleteErr) {
    const errMsg =
      deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
    console.error(
      `[agents] DELETE /:id ${id} — runtimeDeleteAgent THREW: ${errMsg}`,
    );
    // Flush buffered reparent deltas FIRST so WS clients converge to
    // actual disk state before the error response.
    for (const delta of pendingDeltas.values()) emitAgentDelta(delta);
    // CachePoisonedError → return 503 directly (NOT bare-throw to onError)
    // so the response body still carries the `reparented` info the global
    // handler doesn't know about. The router-level onError keeps the
    // simpler routes (POST, PATCH, PUT) covered with a stable 503 +
    // CACHE_POISONED code; here we mirror that shape but add the
    // in-flight state.
    if (deleteErr instanceof CachePoisonedError) {
      return c.json(
        {
          error: deleteErr.message,
          code: deleteErr.code,
          retryable: false,
          ...(reparented.length > 0 && { reparented }),
        },
        503,
      );
    }
    return c.json(
      {
        error: `Failed to delete agent "${id}" — see server logs (${errMsg}). ${reparented.length > 0 ? `Note: ${reparented.length} child(ren) were already reassigned and remain reassigned. Retry the DELETE; the reparent step is now a no-op.` : ""}`,
        ...(reparented.length > 0 && { reparented }),
      },
      500,
    );
  }
  if (!removed) {
    // Same throw-guard pattern as runtimeDeleteAgent above. deleteAgentRaw
    // calls readCache (which can throw if loadAll throws — rare, but
    // possible) and unlinkSync (currently caught internally and returns
    // false, but a future patch may surface CachePoisonedError or other
    // throws here). Without the wrap, an exception bypasses the
    // pendingDeltas flush below — exact same divergence the
    // runtimeDeleteAgent guard prevents in the live-PTY path.
    let rawRemoved: boolean;
    try {
      rawRemoved = deleteAgentRaw(id);
    } catch (rawErr) {
      const errMsg = rawErr instanceof Error ? rawErr.message : String(rawErr);
      console.error(
        `[agents] DELETE /:id ${id} — deleteAgentRaw THREW: ${errMsg}`,
      );
      for (const delta of pendingDeltas.values()) emitAgentDelta(delta);
      // Same direct-503 pattern as the runtimeDeleteAgent branch above —
      // preserve `reparented` info that onError can't see.
      if (rawErr instanceof CachePoisonedError) {
        return c.json(
          {
            error: rawErr.message,
            code: rawErr.code,
            retryable: false,
            ...(reparented.length > 0 && { reparented }),
          },
          503,
        );
      }
      return c.json(
        {
          error: `Failed to delete agent "${id}" — see server logs (${errMsg}). ${reparented.length > 0 ? `Note: ${reparented.length} child(ren) were already reassigned and remain reassigned. Retry the DELETE; the reparent step is now a no-op.` : ""}`,
          ...(reparented.length > 0 && { reparented }),
        },
        500,
      );
    }
    if (!rawRemoved && getAgent(id) !== undefined) {
      console.error(
        `[agents] DELETE /:id ${id} — both removes returned false AND record still in store (real filesystem error)`,
      );
      // Reparents committed to disk before the delete failed. The original
      // goal (delete) didn't complete, but the children DID move. Emit the
      // forward deltas so WS clients converge to actual disk state — same
      // pattern as the rollback-failure branch above. The 500 tells the
      // operator the delete itself failed; the deltas keep the dashboard
      // honest about where children currently sit. A retry will skip the
      // (now-empty) reparent loop and try the delete again.
      for (const delta of pendingDeltas.values()) emitAgentDelta(delta);
      return c.json(
        {
          error: `Failed to delete agent "${id}" — see server logs. ${reparented.length > 0 ? `Note: ${reparented.length} child(ren) were already reassigned and remain reassigned. Retry the DELETE; the reparent step is now a no-op.` : ""}`,
          ...(reparented.length > 0 && { reparented }),
        },
        500,
      );
    }
    // Else: agent is genuinely gone (race resolved itself) — fall through to 200.
  }
  // Delete confirmed — flush the deferred reparent deltas now. Emit AFTER
  // the runtime's own agent.deleted event (which fired inside
  // runtimeDeleteAgent) so clients see deletion before reparents land,
  // which matches the operator's mental model: parent gone → children
  // adopted by reassignTo target.
  for (const delta of pendingDeltas.values()) emitAgentDelta(delta);
  recordEvent({
    type: "agent_exited",
    actorAgentId: id,
    summary: `deleted agent ${agent.name}`,
    project: agent.project ?? null,
    payload: { agentId: id, name: agent.name, reason: "delete" },
  });
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
  recordEvent({
    type: "agent_exited",
    actorAgentId: agent.id,
    summary: `killed agent ${agent.name}`,
    project: agent.project ?? null,
    payload: { agentId: agent.id, name: agent.name, reason: "kill" },
  });
  return c.json({ ok: true, id: agent.id });
});

// ── Restart all (kill + respawn every live PTY) ────────────────────
//
// Replaces the pre-unification `POST /api/sessions/restart-all`. The
// runtime function preserves agent ids across the restart so the
// dashboard's layout/groups/panes stay valid; the returned `idMap` is
// kept for caller compat (currently identity since ids no longer
// change, but the field stays so older clients don't crash).
//
// `failures` carries per-agent respawn errors so the dashboard can
// distinguish "all good" from "5 of 7 came back, 2 are gone" instead
// of showing a uniform "done" green state. The route always returns
// 200 — partial success is still success at the route level — and the
// caller decides how to surface non-empty `failures`.

agentsRouter.post("/restart-all", async (c) => {
  const { idMap, failures } = await restartAllAttachments();
  return c.json({ idMap, failures });
});
