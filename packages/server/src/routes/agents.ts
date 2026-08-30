/**
 * REST API for the unified Agent collection.
 *
 * Replaces /api/sessions and /api/org. Both flat-list and hierarchy-tree
 * views on the dashboard derive their shape from the same payload, so they
 * cannot disagree about what exists.
 */

import {
  type Agent,
  type AgentTreeNode,
  type ExitReason,
  isExitReason,
  permissionModeFromStored,
  type UUID,
} from "@autonomos/core";
import { Hono } from "hono";
import { revokeAgentToken } from "../agentCredentials.js";
import {
  killAttachment,
  restartAllAttachments,
  deleteAgent as runtimeDeleteAgent,
  SpawnError,
  spawnAgent,
} from "../agents/runtime.js";
import {
  buildAgentTree,
  CachePoisonedError,
  childrenOf,
  deleteAgentRaw,
  getAgent,
  getAgentByProviderSessionId,
  listAgents,
  resolveAgent,
  resolveAgentByName,
  setManager,
} from "../agents/store.js";
import { emitAgentDelta } from "../events/agents.js";
import {
  emitPendingHandoffCount,
  injectAllHandoffs,
  injectHandoffItem,
} from "../handoffDelivery.js";
import {
  handoffQueueCount,
  listHandoffQueue,
  removeHandoffItem,
} from "../handoffQueue.js";
import { HttpError, httpErrorResponse } from "../httpError.js";
import { getProvider } from "../providers/index.js";
import { ControlPlaneNotReadyError } from "../serverState.js";
import { getTemplate } from "../templates.js";
import { usageQueue } from "../usageQueue.js";
import {
  parseBody,
  restCreateAgentSchema,
  restSetManagerSchema,
} from "../validation.js";
import { clearAgentState, clearNotifications } from "./hooks.js";

export const agentsRouter = new Hono();

// ── Hand-off queue (manual-queue agents, e.g. Gemini) ──────────────────
// A message to an inbound-less agent is QUEUED for human hand-delivery. These
// endpoints back the dashboard pane: list, deliver one, deliver all, discard.
// Delivery is a PTY injection whose item leaves the queue only on a confirming
// UserPromptSubmit hook (see handoffDelivery.ts) — so "send" returning ok means
// the injection STARTED, not that it's been confirmed yet.

/** List an agent's queued hand-off messages (oldest first). */
agentsRouter.get("/:id/queue", (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);
  return c.json({ items: listHandoffQueue(agent.id) });
});

/** Deliver ALL queued messages, one at a time (each gated on its receipt). */
agentsRouter.post("/:id/queue/send-all", (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);
  const result = injectAllHandoffs(agent.id);
  if (!result.ok) return c.json({ error: result.reason }, 409);
  return c.json({ ok: true, remaining: handoffQueueCount(agent.id) });
});

/** Deliver ONE queued message by id. */
agentsRouter.post("/:id/queue/:itemId/send", (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);
  const result = injectHandoffItem(agent.id, c.req.param("itemId"));
  if (!result.ok) return c.json({ error: result.reason }, 409);
  return c.json({ ok: true });
});

/** Discard ONE queued message by id (no delivery). */
agentsRouter.delete("/:id/queue/:itemId", (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);
  const removed = removeHandoffItem(agent.id, c.req.param("itemId"));
  if (!removed) return c.json({ error: "No such queued item" }, 404);
  // Push the new count so the badge updates live (reuse version — derived state).
  emitPendingHandoffCount(agent.id);
  return c.json({ ok: true, removed });
});

// Map cache-poisoned writes to a stable 503 across the whole agents
// surface. Without this, every patchAgent / setManager / insertAgent
// caller (POST /:id/manager, POST /, MCP tools
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
  // A router-level onError is the NEAREST handler, so the app-level one in
  // httpError.ts never sees these — this branch is what keeps a thrown
  // HttpError (parseBody's 400, say) from falling into the generic 500 below.
  if (err instanceof HttpError) return httpErrorResponse(c, err);
  // A spawn that lands in the boot window before the control socket binds
  // (ADR-055). Distinct from CachePoisonedError below in one important way:
  // this one IS retryable, and clears on its own within a moment of startup —
  // so say so, rather than leaking the raw invariant string as a 500 and
  // leaving the caller to guess whether retrying is pointless.
  if (err instanceof ControlPlaneNotReadyError) {
    console.warn(
      `[agents] ${err.code} on ${c.req.method} ${c.req.path} — spawn arrived before the control socket bound`,
    );
    return c.json(
      { error: err.message, code: err.code, retryable: true },
      503,
      { "Retry-After": "1" },
    );
  }
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

/** Enrich a manual-queue agent with its live pending hand-off count so the
 *  dashboard badge is correct on first load (live changes arrive via deltas).
 *  Non-manual-queue agents and empty queues are returned untouched. A corrupt
 *  queue file must NEVER take down the (always-on) agent list, so an unreadable
 *  queue degrades this one agent to "no badge" with a loud log — the file is
 *  left on disk for recovery, never silently deleted. Exported for the
 *  resilience test that pins the "one bad file can't 500 the list" guarantee. */
export function withPendingHandoffCount(a: Agent): Agent {
  if (
    getProvider(a.provider).capabilities.messaging.inboundMethod !==
    "manual-queue"
  ) {
    return a;
  }
  let count: number;
  try {
    count = handoffQueueCount(a.id);
  } catch (err) {
    console.error(
      `[agents] hand-off queue for ${a.id.slice(0, 8)} is unreadable — badge omitted:`,
      err instanceof Error ? err.message : err,
    );
    return a;
  }
  return count > 0 ? { ...a, pendingHandoffCount: count } : a;
}

agentsRouter.get("/", (c) => {
  return c.json(listAgents().map(withPendingHandoffCount));
});

// Tree-shape variant for clients that can't build the tree themselves
// (e.g. external MCP clients). Same data, just nested by managerId.
agentsRouter.get("/tree", (c) => {
  const includeExited = c.req.query("includeExited") === "true";
  const tree = buildAgentTree<AgentTreeNode>({
    includeExited,
    mapNode: (a) => ({
      id: a.id,
      claudeSessionId: a.id,
      name: a.name,
      template: a.template,
      project: a.project,
      status: a.status,
      provider: a.provider,
      permissionMode: a.permissionMode,
    }),
  });
  return c.json(tree);
});

agentsRouter.get("/:id", (c) => {
  const id = c.req.param("id");
  const agent = resolveAgent(id);
  if (!agent) return c.json({ error: `Agent "${id}" not found` }, 404);
  // Enrich with the pending hand-off count too, so a single-agent fetch agrees
  // with the list endpoint (same corrupt-file-safe helper).
  return c.json(withPendingHandoffCount(agent));
});

// ── Create ─────────────────────────────────────────────────────────

/**
 * Map a spawnAgent failure to an HTTP status.
 *
 * Extracted and exported so the mapping is testable without a PTY — the phrases
 * are authored in agents/runtime.ts and matched here, a cross-file coupling.
 * `assertAdoptable`'s messages are pinned end-to-end in external-cc-resume.test.ts;
 * the inline throws in `spawnAgent` ("nothing to resume", "refusing to adopt",
 * "already attached") are pinned only as string literals — reword THOSE and an
 * actionable 4xx silently degrades to a 500, which the dashboard renders as a
 * bare "HTTP 500" instead of the reason.
 *
 * ORDER MATTERS — several of these messages interpolate caller-supplied text (an
 * adopt error embeds cwd and session id; the 409s embed the agent name), so any
 * phrase can appear inside any message. The order puts the adopt-specific
 * phrases ahead of the generic "not found", which is the hazard that actually
 * bites: a cwd containing "not found" would otherwise flip a 422 into a 404. It
 * is NOT injection-proof in the other direction — an agent literally named
 * "nothing to resume" classifies 422, not 409. Accepted as low-risk.
 *
 * (Substring sniffing is fragile — typed Error subclasses plus a central
 * onError would be the durable shape. Deliberately out of scope for this fix;
 * extracting it here at least makes the current behavior verifiable.)
 */
export function spawnErrorStatus(message: string): 400 | 404 | 409 | 422 | 500 {
  // Malformed or empty resume/fork id — a non-UUID resumeSessionId
  // (assertAdoptable) or any of the three id fields present-but-empty/non-string
  // (the spawnAgent boundary guard). A bad request, not a server fault.
  if (message.includes("invalid session id")) return 400;
  // Adopt preconditions: no saved conversation on disk, a provider that cannot
  // adopt at all, or a probe we couldn't trust. Client-side situations — and
  // never silently downgraded to a fresh session.
  if (
    message.includes("nothing to resume") ||
    message.includes("refusing to adopt")
  ) {
    return 422;
  }
  // Client errors that previously fell through to 500. A 500 tells every other
  // client (and any retry logic) "server fault, retry" for a request that can
  // never succeed as-sent. "Invalid working directory" is the most commonly hit
  // of these — any typo'd or deleted path, including a record whose worktree was
  // removed by wt-sync.
  if (
    message.includes("Invalid working directory") ||
    message.includes("Cannot use both")
  ) {
    return 400;
  }
  // Env preset problems (ADR-067): a referenced preset that doesn't exist, or one
  // whose API key a human hasn't set yet. A client-config error, not a server
  // fault — and it must beat the generic "not found" → 404 below, so a keyless
  // preset reads as "fix your preset" (400) rather than "no such agent" (404).
  if (message.includes("Env preset")) return 400;
  // Name collision with a live agent.
  if (message.includes("already running")) return 409;
  // Resuming a session whose agent is already live. `/attach` maps this exact
  // condition to 409, so the create/resume path must agree — same user error,
  // same status, whichever entry point they came through.
  if (message.includes("already attached")) return 409;
  if (message.includes("not found")) return 404;
  return 500;
}

agentsRouter.post("/", async (c) => {
  // Body SHAPE only (validation.ts). Everything below — template resolution,
  // manager lookup, the permissionMode fallback — is domain validation and
  // keeps its own statuses and messages.
  const body = await parseBody(c, restCreateAgentSchema);

  // Resolve template if provided. getTemplate() returns null for a missing file
  // but THROWS for a corrupt one (bad JSON, wrong shape) — the message names the
  // file. Catch it here and map to 400: unwrapped, the throw escapes to Hono's
  // default handler and becomes an opaque 500, dropping exactly the guidance an
  // operator needs. The MCP create_agent path already wraps this call, so
  // without this the two surfaces disagree about the same corrupt file.
  const templateName = body.template;
  let tmpl: ReturnType<typeof getTemplate> = null;
  try {
    tmpl = templateName ? getTemplate(templateName) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: `Template "${templateName}": ${message}` }, 400);
  }
  if (templateName && !tmpl) {
    return c.json({ error: `Template "${templateName}" not found` }, 400);
  }

  // Resolve manager — accept either managerId (UUID) or manager (name).
  // Name takes precedence if both supplied since MCP/UI surfaces use names.
  let managerId: UUID | null = null;
  if (body.manager) {
    const mgr = resolveAgentByName(body.manager);
    if (!mgr) {
      return c.json({ error: `Manager "${body.manager}" not found` }, 400);
    }
    managerId = mgr.id;
  } else if (body.managerId !== undefined) {
    if (!getAgent(body.managerId)) {
      return c.json({ error: `managerId "${body.managerId}" not found` }, 400);
    }
    managerId = body.managerId;
  }

  const systemPrompt = body.appendSystemPrompt ?? tmpl?.systemPrompt;
  // `permissionModeFromStored` also accepts the pre-rename spelling
  // ("default" → "ask"), so a client holding the older tool schema — every
  // agent spawned before that rename — keeps working instead of failing.
  //
  // The result is deliberately left as `undefined` when the caller said
  // nothing. Resolving it to a concrete mode HERE is what silently demoted a
  // deliberately autonomous agent on a body-less resume: spawnAgent could no
  // longer tell "the caller asked for ask" from "the caller said nothing", and
  // wrote the fallback over the record. spawnAgent owns the fallback; this
  // boundary only reports what was asked for.
  const permissionMode = permissionModeFromStored(body.permissionMode);
  // An unusable mode falls back rather than 400s, so say so — silence here
  // reads as "accepted". The dashboard and MCP (z.enum) paths only send valid
  // values; this guards hand-crafted requests.
  if (body.permissionMode !== undefined && permissionMode === undefined)
    console.warn(
      `[api/agents] ignoring invalid permissionMode ${JSON.stringify(body.permissionMode)}; falling back to template/record/default`,
    );

  // NOTE: the present-but-empty resume/fork id check lives in `spawnAgent`, not
  // here. It has to be at the shared boundary — the HTTP MCP handler calls
  // spawnAgent directly and would bypass a route-level guard. It surfaces below
  // via spawnErrorStatus as a 400.
  try {
    const result = await spawnAgent({
      workingDirectory: body.workingDirectory,
      name: body.name,
      prompt: body.prompt,
      // The three id fields are forwarded RAW (not coerced to undefined on a
      // type mismatch) so spawnAgent's boundary guard can reject a present-but-
      // malformed value. Coercing here would silently drop `resumeSessionId: 42`
      // and answer a resume request with a brand-new empty agent.
      resumeAgentId: body.resumeAgentId as UUID | undefined,
      // Raw provider (CC) session id — reattach a managed record OR adopt an
      // external terminal-started session. Distinct id-space from resumeAgentId.
      resumeSessionId: body.resumeSessionId as string | undefined,
      forkFromAgentId: body.forkFromAgentId as UUID | undefined,
      permissionMode,
      // Ranked BELOW the record on a resume — see SpawnParams. Naming a
      // template while resuming must not re-level an existing agent.
      templatePermissionMode: tmpl?.permissionMode,
      appendSystemPrompt: systemPrompt,
      template: templateName,
      managerId,
      project: body.project,
      cols: body.cols,
      rows: body.rows,
      provider: body.provider,
      // Env preset (model override, ADR-067). Forwarded raw; spawnAgent resolves
      // it against the record on a body-less resume. undefined = no override /
      // keep the resumed agent's existing preset.
      envPreset: body.envPreset,
    });
    return c.json(result.agent, 201);
  } catch (err) {
    // Let the boot-window case reach onError, which owns the 503 + Retry-After
    // shape. Re-throwing rather than duplicating that response here keeps one
    // definition of "not ready yet" — this local catch exists to classify
    // SPAWN failures, and "the server hasn't finished starting" isn't one.
    if (err instanceof ControlPlaneNotReadyError) throw err;
    const message = err instanceof Error ? err.message : "Unknown error";
    // Typed status when the throw site declared one; substring chain otherwise.
    return c.json(
      { error: message },
      err instanceof SpawnError ? err.status : spawnErrorStatus(message),
    );
  }
});

// `PATCH /:id` (rename / template / project) was removed: zero callers, zero
// tests, and it carried the surface's only header-based optimistic concurrency
// (`If-Match`, vs. the body `version` everything else uses). A future rename /
// reparent UI re-adds it on the body-`version` convention.

// ── Set manager ────────────────────────────────────────────────────

agentsRouter.post("/:id/manager", async (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);

  const body = await parseBody(c, restSetManagerSchema);

  // Accept either managerId (UUID) or manager (name). Null/undefined clears.
  let managerId: UUID | null;
  if (body.manager) {
    const mgr = resolveAgentByName(body.manager);
    if (!mgr) {
      return c.json({ error: `Manager "${body.manager}" not found` }, 404);
    }
    managerId = mgr.id;
  } else {
    managerId = body.managerId ?? null;
  }

  const result = setManager(agent.id, managerId, body.version);
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

agentsRouter.post("/:id/attach", async (c) => {
  const param = c.req.param("id");
  // Resolve by agent id or name, then fall back to the CC providerSessionId.
  // The Projects panel keys managed sessions by their CC session id, which for
  // split-id agents (spawned post-#165, before id==providerSessionId was
  // unified) is NOT the agent id — without this fallback those 404 on resume.
  const agent = resolveAgent(param) ?? getAgentByProviderSessionId(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);

  try {
    const result = await spawnAgent({
      workingDirectory: agent.workingDirectory,
      resumeAgentId: agent.id,
      name: agent.name,
      permissionMode: agent.permissionMode,
      template: agent.template,
      managerId: agent.managerId,
      project: agent.project,
      provider: agent.provider,
      // Record-driven resume: re-apply the persisted preset (ADR-067). No body,
      // so this is the record's own value — cannot re-level the agent.
      envPreset: agent.envPreset,
    });
    return c.json(result.agent);
  } catch (err) {
    // ADR-055: the boot-window case must reach onError (retryable 503) rather
    // than fall into the classifier below, which would map it to a generic
    // status. Re-throw before any classification. See POST / above.
    if (err instanceof ControlPlaneNotReadyError) throw err;
    // Same classifier as POST / — spawnErrorStatus's doc asserts the two entry
    // points agree on a given user error, and a hand-rolled mapping here made
    // that false: /attach passes `name: agent.name`, so a live namesake threw
    // "already running" and returned 500 where POST returned 409.
    const message = err instanceof Error ? err.message : "Unknown error";
    // Typed status when the throw site declared one; substring chain otherwise.
    return c.json(
      { error: message },
      err instanceof SpawnError ? err.status : spawnErrorStatus(message),
    );
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
    // simpler POST routes covered with a stable 503 + CACHE_POISONED
    // code; here we mirror that shape but add the in-flight state.
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
  // Delete confirmed — reclaim the hook state with the record. Idempotent: a
  // no-op on the common path, where runtimeDeleteAgent already cleared. It is
  // here for the paths where it did not — that clear sits inside `if (removed)`,
  // so a delete that succeeded only via `wasLive`, or via the raw fallback
  // below, arrives still holding state.
  //
  // Those two paths are UNTESTED — both need a live PTY or a mid-delete store
  // failure to reach, and the suites drive runtime.deleteAgent directly, which
  // exercises only the common path. Stated so the next reader can re-judge the
  // call rather than trust a claim nothing enforces.
  // Revoke here TOO, not only in deleteAgentRaw: on the wasLive-only path
  // (live PTY, record already absent from the store cache) deleteAgentRaw
  // returns false at its not-found guard BEFORE its revoke, yet deleteAgent
  // still reports true via wasLive — leaving the dying PTY's token valid to
  // resurrect the state cleared below. Idempotent on every other path.
  revokeAgentToken(id);
  clearAgentState(id);
  clearNotifications(id);
  // Disarm any queued auto-Enter: an armed pane for a DELETED agent would
  // otherwise fire hours later against a gone PTY and push a notification
  // under an id nothing can resolve (same invariant as the clears). Lives in
  // the route, not runtime.deleteAgent — usageQueue imports from runtime, so
  // the reverse edge would close a cycle. UNTESTED via the route for the same
  // reason as the clears below; the queue's own disarm behavior is unit-tested.
  usageQueue().disarm(id);
  // Flush the deferred reparent deltas now. Emit AFTER
  // the runtime's own agent.deleted event (which fired inside
  // runtimeDeleteAgent) so clients see deletion before reparents land,
  // which matches the operator's mental model: parent gone → children
  // adopted by reassignTo target.
  for (const delta of pendingDeltas.values()) emitAgentDelta(delta);
  return c.json({ ok: true, id });
});

// ── Kill (PTY only, keep agent record) ─────────────────────────────

agentsRouter.post("/:id/kill", async (c) => {
  const param = c.req.param("id");
  const agent = resolveAgent(param);
  if (!agent) return c.json({ error: `Agent "${param}" not found` }, 404);
  // Optional { reason } body. Defaults to "user_killed" (operator kill);
  // self_exit posts "self_exited". A missing/empty body is the common,
  // legitimate case (dashboard + kill_agent send none) → silent default.
  // A present-but-unrecognized reason is logged (not silently coerced) so a
  // typo or a future ExitReason the caller forgot to whitelist surfaces in
  // logs instead of masquerading as an operator kill.
  const body = await c.req.json().catch(() => null);
  const rawReason = (body as { reason?: unknown } | null)?.reason;
  let reason: ExitReason = "user_killed";
  if (isExitReason(rawReason)) {
    reason = rawReason;
  } else if (rawReason !== undefined && rawReason !== null) {
    console.error(
      `[agents] POST /:id/kill ${param} got unrecognized reason ${JSON.stringify(rawReason)} — defaulting to "user_killed"`,
    );
  }
  const killed = killAttachment(agent.id, reason);
  if (!killed) {
    return c.json(
      { error: `Agent "${param}" has no live attachment to kill` },
      409,
    );
  }
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
