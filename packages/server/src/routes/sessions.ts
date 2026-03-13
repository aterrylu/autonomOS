import { Hono } from "hono";
import { getPinnedSessions, pinSession, unpinSession } from "../pinned.js";
import {
  createSession,
  getAllSessions,
  getSession,
  killSession,
} from "../sessions.js";

export const sessionRouter = new Hono();

sessionRouter.get("/", (c) => c.json(getAllSessions()));

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
    const managed = createSession({
      workingDirectory: body.workingDirectory,
      name: typeof body.name === "string" ? body.name : undefined,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      resumeSessionId:
        typeof body.resumeSessionId === "string"
          ? body.resumeSessionId
          : undefined,
      autonomousMode: body.autonomousMode === true,
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

// Get all pinned sessions (for debugging/visibility)
sessionRouter.get("/pinned", (c) => {
  return c.json(getPinnedSessions());
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

// Pin a session — saves config so it auto-resumes on server restart
sessionRouter.post("/:id/pin", (c) => {
  const managed = getSession(c.req.param("id"));
  if (!managed) return c.json({ error: "Session not found" }, 404);

  const { session } = managed;
  if (!session.claudeSessionId) {
    return c.json(
      { error: "Only sessions with a Claude session ID can be pinned" },
      400,
    );
  }

  pinSession({
    claudeSessionId: session.claudeSessionId,
    workingDirectory: session.workingDirectory,
    name: session.name,
    autonomousMode: true, // pinned sessions always resume in autonomous mode
    pinnedAt: Date.now(),
  });

  session.pinned = true;
  return c.json({ ok: true, pinned: true });
});

// Unpin a session
sessionRouter.delete("/:id/pin", (c) => {
  const managed = getSession(c.req.param("id"));
  if (!managed) return c.json({ error: "Session not found" }, 404);

  const { session } = managed;
  if (!session.claudeSessionId) {
    return c.json({ error: "Session has no Claude session ID" }, 400);
  }

  unpinSession(session.claudeSessionId);
  session.pinned = false;
  return c.json({ ok: true, pinned: false });
});
