import { Hono } from "hono";
import {
  batchUpdatePersistedSessionNames,
  getPersistedSessions,
} from "../persisted.js";
import {
  createSession,
  getAllSessions,
  getSession,
  killSession,
  permanentlyRemoveSession,
  resolveSessionId,
  restartAllSessions,
} from "../sessions.js";
import { getTemplate } from "../templates.js";
import { batchGetTitles } from "../titleCache.js";

export const sessionRouter = new Hono();

sessionRouter.get("/", async (c) => {
  const sessions = getAllSessions();

  // Enrich session names with latest JSONL titles (picks up /rename).
  // Returns new objects to avoid mutating the in-memory session store.
  const sessionsWithClaude = sessions
    .filter((s) => s.claudeSessionId)
    .map((s) => ({
      sessionId: s.claudeSessionId!,
      cwd: s.workingDirectory,
    }));

  if (sessionsWithClaude.length === 0) return c.json(sessions);

  // Best-effort title enrichment — never block session list on title failures
  let titles = new Map<string, string>();
  try {
    titles = await batchGetTitles(sessionsWithClaude);
  } catch (err) {
    console.warn(
      "Failed to enrich session titles:",
      err instanceof Error ? err.message : err,
    );
  }

  // Persist renamed titles to sessions.json so they survive restart.
  // Batched into a single read-modify-write cycle, best-effort (never fail the list).
  try {
    const nameUpdates: Array<{ claudeSessionId: string; name: string }> = [];
    for (const s of sessions) {
      if (s.claudeSessionId) {
        const title = titles.get(s.claudeSessionId);
        if (title && title !== s.name) {
          nameUpdates.push({ claudeSessionId: s.claudeSessionId, name: title });
        }
      }
    }
    batchUpdatePersistedSessionNames(nameUpdates);
  } catch (err) {
    console.warn(
      "Failed to persist renamed titles:",
      err instanceof Error ? err.message : err,
    );
  }

  // Build persisted data lookup for enriching live sessions with template/manager/project
  // Best-effort — never block the session list on persistence failures
  const persistedMap = new Map<
    string,
    ReturnType<typeof getPersistedSessions>[number]
  >();
  try {
    for (const p of getPersistedSessions()) {
      persistedMap.set(p.claudeSessionId, p);
    }
  } catch (err) {
    console.warn(
      "Failed to load persisted session data for enrichment:",
      err instanceof Error ? err.message : err,
    );
  }

  const enriched = sessions.map((s) => {
    const persisted = s.claudeSessionId
      ? persistedMap.get(s.claudeSessionId)
      : undefined;
    const title = s.claudeSessionId ? titles.get(s.claudeSessionId) : undefined;
    if (persisted || title) {
      return {
        ...s,
        ...(title ? { name: title } : {}),
        template: persisted?.template,
        manager: persisted?.manager,
        project: persisted?.project,
      };
    }
    return s;
  });

  // Append exited sessions from persistence (not already in live sessions)
  const liveClaudeIds = new Set<string>();
  for (const s of sessions) {
    if (s.claudeSessionId) liveClaudeIds.add(s.claudeSessionId);
  }

  const exitedSessions = getPersistedSessions()
    .filter(
      (p) => p.status === "exited" && !liveClaudeIds.has(p.claudeSessionId),
    )
    .map((p) => ({
      id: p.claudeSessionId,
      name: p.name,
      status: "exited" as const,
      workingDirectory: p.workingDirectory,
      provider: "claude-code",
      claudeSessionId: p.claudeSessionId,
      createdAt: p.persistedAt,
      updatedAt: p.persistedAt,
      template: p.template,
      manager: p.manager,
      project: p.project,
    }));

  return c.json([...enriched, ...exitedSessions]);
});

sessionRouter.post("/", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.workingDirectory || typeof body.workingDirectory !== "string") {
    return c.json({ error: "workingDirectory is required" }, 400);
  }

  if (body.cols != null && (typeof body.cols !== "number" || body.cols <= 0)) {
    return c.json({ error: "cols must be a positive number" }, 400);
  }
  if (body.rows != null && (typeof body.rows !== "number" || body.rows <= 0)) {
    return c.json({ error: "rows must be a positive number" }, 400);
  }

  if (
    body.resumeSessionId != null &&
    (typeof body.resumeSessionId !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(body.resumeSessionId))
  ) {
    return c.json(
      { error: "resumeSessionId must be alphanumeric (a-z, 0-9, -, _)" },
      400,
    );
  }

  try {
    // Resolve template if provided
    const templateName =
      typeof body.template === "string" ? body.template : undefined;
    const tmpl = templateName ? getTemplate(templateName) : null;
    if (templateName && !tmpl) {
      return c.json({ error: `Template "${templateName}" not found` }, 400);
    }

    const agentName = typeof body.name === "string" ? body.name : undefined;
    const systemPrompt =
      typeof body.appendSystemPrompt === "string"
        ? body.appendSystemPrompt
        : tmpl?.systemPrompt;
    const autonomousMode =
      (body.autonomousMode ?? tmpl?.autonomousMode) === true;

    const managed = createSession({
      workingDirectory: body.workingDirectory,
      name: agentName,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      resumeSessionId:
        typeof body.resumeSessionId === "string"
          ? body.resumeSessionId
          : undefined,
      autonomousMode,
      appendSystemPrompt: systemPrompt,
      template: templateName,
      manager: typeof body.manager === "string" ? body.manager : undefined,
      project: typeof body.project === "string" ? body.project : undefined,
      cols: body.cols as number | undefined,
      rows: body.rows as number | undefined,
    });
    return c.json(managed.session, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // Name collision is a client error (409), not a server failure (500)
    if (message.includes("already running")) {
      return c.json({ error: message }, 409);
    }
    console.error("Failed to create session:", message);
    return c.json(
      { error: "Failed to spawn agent process", detail: message },
      500,
    );
  }
});

sessionRouter.post("/:id/resume", (c) => {
  const claudeSessionId = c.req.param("id");

  // Guard: prevent resuming a session that's already live
  const allLive = getAllSessions();
  const alreadyLive = allLive.some(
    (s) => s.claudeSessionId === claudeSessionId,
  );
  if (alreadyLive) {
    return c.json({ error: "Session is already running" }, 409);
  }

  const persisted = getPersistedSessions();
  const entry = persisted.find(
    (p) => p.claudeSessionId === claudeSessionId && p.status === "exited",
  );
  if (!entry) {
    return c.json({ error: "Exited session not found" }, 404);
  }

  // Guard: prevent resuming if an active agent with the same name exists
  const nameCollision = allLive.find(
    (s) => s.name.toLowerCase() === entry.name.toLowerCase(),
  );
  if (nameCollision) {
    return c.json(
      {
        error: `Cannot resume — an active agent named "${entry.name}" is already running. Kill it first or rename it.`,
      },
      409,
    );
  }

  try {
    // Re-resolve template for role context
    const tmpl = entry.template ? getTemplate(entry.template) : null;
    if (entry.template && !tmpl) {
      console.warn(
        `Template "${entry.template}" not found for ${entry.name} — resuming without role context`,
      );
    }

    const managed = createSession({
      workingDirectory: entry.workingDirectory,
      name: entry.name,
      resumeSessionId: claudeSessionId,
      autonomousMode: entry.autonomousMode,
      appendSystemPrompt: tmpl?.systemPrompt,
      template: entry.template,
      manager: entry.manager,
      project: entry.project,
    });
    return c.json(managed.session, 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    if (message.includes("already running")) {
      return c.json({ error: message }, 409);
    }
    console.error(`Failed to resume session ${claudeSessionId}:`, message);
    return c.json(
      { error: "Failed to resume agent process", detail: message },
      500,
    );
  }
});

sessionRouter.post("/restart-all", (c) => {
  const idMap = restartAllSessions();
  return c.json({ restarted: Object.keys(idMap).length, idMap });
});

sessionRouter.get("/:id", (c) => {
  const managed = getSession(c.req.param("id"));
  if (!managed) return c.json({ error: "Session not found" }, 404);
  return c.json(managed.session);
});

sessionRouter.delete("/:id", async (c) => {
  const permanent = c.req.query("permanent") === "true";
  const id = c.req.param("id");

  if (permanent) {
    // Permanent removal — kill PTY if live, then delete from sessions.json
    if (!permanentlyRemoveSession(id)) {
      return c.json({ error: "Session not found" }, 404);
    }
    return c.json({ ok: true });
  }

  // Default: kill PTY, mark as exited in persistence
  // Try direct UUID kill first
  if (killSession(id)) return c.json({ ok: true });
  // Fall back to name resolution (case-insensitive, titleCache)
  const resolved = await resolveSessionId(id);
  if ("error" in resolved) return c.json({ error: resolved.error }, 404);
  if (!killSession(resolved.id))
    return c.json(
      {
        error: `Agent "${id}" was found but exited before it could be terminated`,
      },
      409,
    );
  return c.json({ ok: true });
});
