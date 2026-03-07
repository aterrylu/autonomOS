import { Hono } from "hono";
import { getAllSessions, createSession, getSession, killSession } from "../sessions";

export const sessionRouter = new Hono();

// List all sessions
sessionRouter.get("/", (c) => {
  return c.json(getAllSessions());
});

// Create a new session (spawn Claude Code)
sessionRouter.post("/", async (c) => {
  const body = await c.req.json<{
    workingDirectory: string;
    prompt?: string;
    cols?: number;
    rows?: number;
  }>();

  const managed = createSession({
    workingDirectory: body.workingDirectory,
    prompt: body.prompt,
    cols: body.cols,
    rows: body.rows,
  });

  return c.json(managed.session, 201);
});

// Get a single session
sessionRouter.get("/:id", (c) => {
  const managed = getSession(c.req.param("id"));
  if (!managed) return c.json({ error: "Session not found" }, 404);
  return c.json(managed.session);
});

// Kill a session
sessionRouter.delete("/:id", (c) => {
  const killed = killSession(c.req.param("id"));
  if (!killed) return c.json({ error: "Session not found" }, 404);
  return c.json({ ok: true });
});
