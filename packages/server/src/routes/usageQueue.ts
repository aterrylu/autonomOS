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
  getRateLimits,
  invalidateCache,
  setUsageOverride,
} from "../plugins/claude-usage/scanner.js";
import { evaluateCap, usageQueue } from "../usageQueue.js";

export const usageQueueRouter = new Hono();

/** Dev/QA simulation is opt-in via env — inert (404) in normal/prod runs. */
const simulationEnabled = (): boolean =>
  !!process.env.AUTONOMOS_ENABLE_USAGE_SIMULATION;

type SimState = "capped" | "cleared" | "off";

/** Default reset hint when none is given — far enough out to look real. */
const DEFAULT_RESET_SEC = (2 * 60 + 13) * 60;

/** Build a scripted usage snapshot for a simulation state (null clears it).
 * `capped` = 100% on the 5-hour window; `cleared` = a small non-zero so the
 * drop is unambiguous. `resetInSec` controls how far out the reset hint is (so
 * the button shows a short ETA for a timed demo). */
function simulatedUsage(
  state: SimState,
  resetInSec = DEFAULT_RESET_SEC,
): RateLimitData | null {
  if (state === "off") return null;
  const resetsAt = new Date(Date.now() + resetInSec * 1000).toISOString();
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

/** Pending auto-clear timer for a `resetInSec` demo (only one at a time). */
let simClearTimer: ReturnType<typeof setTimeout> | null = null;

function cancelSimClear(): void {
  if (simClearTimer) {
    clearTimeout(simClearTimer);
    simClearTimer = null;
  }
}

/**
 * Flip the simulated state to cleared and fire any armed panes — the action a
 * `resetInSec` countdown runs when it elapses. Exported so a test can trigger
 * the transition deterministically without waiting out a real timer.
 */
export async function applySimulatedClear(): Promise<void> {
  setUsageOverride(simulatedUsage("cleared"));
  invalidateCache();
  await usageQueue().tick();
}

/**
 * Current armed sessions + whether the account is at the usage cap + the
 * nearest reset (for the button's "show only at the limit" visibility + ETA).
 *
 * `capped`/`resetsAt` come from a fresh usage read (cached 60s) rather than the
 * watcher's armed-only `blocked`, so the button can appear before anything is
 * armed — otherwise visibility would depend on arming, which needs the button.
 */
usageQueueRouter.get("/", async (c) => {
  const { armed } = usageQueue().status();
  const { capped, resetsAt } = evaluateCap(await getRateLimits());
  return c.json({ armed, capped, resetsAt });
});

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

  // `capped&resetInSec=N` caps now and auto-clears after N seconds — so you can
  // arm a pane and watch the auto-Enter fire on its own, without a second call.
  const resetRaw = Number(c.req.query("resetInSec"));
  const resetInSec =
    state === "capped" && Number.isFinite(resetRaw) && resetRaw > 0
      ? resetRaw
      : undefined;

  cancelSimClear(); // supersede any prior countdown
  setUsageOverride(simulatedUsage(state, resetInSec));
  invalidateCache(); // drop any cached real reading so the override takes effect
  await usageQueue().tick(); // react now, don't wait for the next poll

  if (resetInSec !== undefined) {
    simClearTimer = setTimeout(() => {
      void applySimulatedClear();
    }, resetInSec * 1000);
    simClearTimer.unref?.();
  }

  return c.json({
    ok: true,
    state,
    resetInSec: resetInSec ?? null,
    status: usageQueue().status(),
  });
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
