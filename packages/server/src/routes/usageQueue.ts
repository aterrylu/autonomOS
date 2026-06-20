/**
 * REST API for the usage queue — arm/disarm a pane's auto-send and read the
 * current armed set + block status.
 *
 * The dashboard polls GET to render the per-pane button and an ETA hint, and
 * POSTs/DELETEs to toggle. All state lives in {@link ../usageQueue} (in-memory,
 * server-side); these routes are a thin shell over it.
 */

import { Hono } from "hono";
import type { RateLimitData } from "../plugins/claude-usage/scanner.js";
import {
  invalidateCache,
  setUsageOverride,
} from "../plugins/claude-usage/scanner.js";
import { usageQueue } from "../usageQueue.js";

export const usageQueueRouter = new Hono();

/** Dev/QA simulation is opt-in via env — inert (404) in normal/prod runs. */
const simulationEnabled = (): boolean =>
  !!process.env.AUTONOMOS_ENABLE_USAGE_SIMULATION;

type SimState = "capped" | "cleared" | "off";

/** Build a scripted usage snapshot for a simulation state (null clears it).
 * `capped` = 100% on the 5-hour window; `cleared` = a small non-zero so the
 * drop is unambiguous. The reset hint is ~2h13m out so the button shows an ETA. */
function simulatedUsage(state: SimState): RateLimitData | null {
  if (state === "off") return null;
  const resetsAt = new Date(Date.now() + (2 * 60 + 13) * 60_000).toISOString();
  return {
    fiveHour: { utilization: state === "capped" ? 100 : 2, resetsAt },
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    account: {},
    fetchedAt: new Date().toISOString(),
  };
}

/** Current armed sessions + account block status (for the button + ETA). */
usageQueueRouter.get("/", (c) => c.json(usageQueue().status()));

/**
 * Dev/QA: simulate a usage-limit transition so the queue can be demoed without
 * hitting a real limit. `?state=capped|cleared|off` overrides what
 * `getRateLimits` returns (so the dashboard usage panel AND the queue watcher
 * both see it), then kicks an immediate evaluation instead of waiting for the
 * 60s poll. Gated behind AUTONOMOS_ENABLE_USAGE_SIMULATION — 404 otherwise.
 *
 * Registered before `/:sessionId` so the literal path wins over the param.
 */
usageQueueRouter.post("/_simulate", async (c) => {
  if (!simulationEnabled()) {
    return c.json({ error: "usage simulation is disabled" }, 404);
  }
  const state = c.req.query("state");
  if (state !== "capped" && state !== "cleared" && state !== "off") {
    return c.json({ error: "state must be capped, cleared, or off" }, 400);
  }
  setUsageOverride(simulatedUsage(state));
  invalidateCache(); // drop any cached real reading so the override takes effect
  await usageQueue().tick(); // react now, don't wait for the next poll
  return c.json({ ok: true, state, status: usageQueue().status() });
});

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
