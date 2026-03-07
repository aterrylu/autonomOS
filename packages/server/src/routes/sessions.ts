import { Hono } from "hono";
import { getAllSessions, createSession, getSession, killSession } from "../sessions.js";

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

  try {
    const managed = createSession({
      workingDirectory: body.workingDirectory,
      prompt: typeof body.prompt === "string" ? body.prompt : undefined,
      cols: body.cols as number | undefined,
      rows: body.rows as number | undefined,
    });
    return c.json(managed.session, 201);
  } catch (err) {
    console.error("Failed to create session:", err);
    return c.json({ error: "Failed to spawn agent process" }, 500);
  }
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
