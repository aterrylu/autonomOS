/**
 * REST API for the usage queue — arm/disarm a pane's auto-send and read the
 * current armed set + block status.
 *
 * The dashboard polls GET to render the per-pane button and an ETA hint, and
 * POSTs/DELETEs to toggle. All state lives in {@link ../usageQueue} (in-memory,
 * server-side); these routes are a thin shell over it.
 */

import { Hono } from "hono";
import { usageQueue } from "../usageQueue.js";

export const usageQueueRouter = new Hono();

/** Current armed sessions + account block status (for the button + ETA). */
usageQueueRouter.get("/", (c) => c.json(usageQueue().status()));

/** Arm auto-send for a pane: press Enter when the usage limit next clears. */
usageQueueRouter.post("/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  usageQueue().arm(sessionId);
  return c.json({ armed: true });
});

/** Disarm auto-send for a pane. */
usageQueueRouter.delete("/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  usageQueue().disarm(sessionId);
  return c.json({ armed: false });
});
