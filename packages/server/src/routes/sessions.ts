import { Hono } from "hono";
import {
  createSession,
  getAllSessions,
  getSession,
  killSession,
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

  const enriched = sessions.map((s) => {
    if (s.claudeSessionId) {
      const title = titles.get(s.claudeSessionId);
      if (title) return { ...s, name: title };
    }
    return s;
  });

  return c.json(enriched);
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
    console.error("Failed to create session:", message);
    return c.json(
      { error: "Failed to spawn agent process", detail: message },
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

sessionRouter.delete("/:id", (c) => {
  const killed = killSession(c.req.param("id"));
  if (!killed) return c.json({ error: "Session not found" }, 404);
  return c.json({ ok: true });
});
