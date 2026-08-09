/**
 * REST API for the usage queue — arm/disarm a pane's auto-send and read the
 * current armed set + block status.
 *
 * The dashboard polls GET to render the per-pane button and an ETA hint, and
 * POSTs/DELETEs to toggle. All state lives in {@link ../usageQueue} (in-memory,
 * server-side); these routes are a thin shell over it.
 */

import type { Provider, UUID } from "@autonomos/core";
import { Hono } from "hono";
import { getAgent, listAgents } from "../agents/store.js";
import type { RateLimitData } from "../plugins/claude-usage/scanner.js";
import {
  invalidateCache,
  setUsageOverride,
} from "../plugins/claude-usage/scanner.js";
import {
  type CapStatus,
  evaluateCap,
  REAL_PROBES,
  usageQueue,
} from "../usageQueue.js";

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
  // Fresh per-provider caps (each scanner is cached ~60s). A pane's button reads
  // ONLY its own provider's cap, so a Claude limit never lights a Codex pane.
  // Gemini has no probe → no entry → its panes never show the button.
  // Probe ONLY providers that actually have an agent in the fleet. A pane can
  // only exist for a provider that has an agent, so this still covers every
  // pane's button — but a Claude-only user never triggers the Codex probe,
  // whose no-auth/expired-token path does an uncached recursive rollout scan
  // (~/.codex/sessions/**). Without this gate that ran 4×/min per open tab (Nox).
  const activeProviders = new Set(listAgents().map((a) => a.provider));
  const caps: Record<string, CapStatus> = {};
  for (const [provider, probe] of Object.entries(REAL_PROBES)) {
    if (probe && activeProviders.has(provider as Provider)) {
      caps[provider] = evaluateCap(await probe());
    }
  }
  return c.json({ armed, caps });
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

/** Arm auto-send for a pane: press Enter when THAT AGENT'S runtime usage limit
 *  next clears. The provider is resolved server-side from the agent record so
 *  the pane waits on the right limit (Claude vs Codex); a runtime with no usage
 *  source (Gemini) arms as a no-op. */
usageQueueRouter.post("/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  const agent = getAgent(sessionId as UUID);
  if (!agent) return c.json({ error: `Agent "${sessionId}" not found` }, 404);
  usageQueue().arm(sessionId, agent.provider);
  // Report the ACTUAL armed state, not an assumed one: arm() is a no-op for a
  // provider with no usage source (gemini), so a truthful response lets the
  // client's optimistic flip reconcile instead of showing a phantom armed (Nox).
  return c.json({
    armed: usageQueue().isArmed(sessionId),
    provider: agent.provider,
  });
});

/** Disarm auto-send for a pane. */
usageQueueRouter.delete("/:sessionId", (c) => {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  usageQueue().disarm(sessionId);
  return c.json({ armed: false });
});
