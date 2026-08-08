/**
 * Channel-server registration verification — escalating probes + retraction.
 *
 * OUTBOUND (send + org tools) rides a channel-server MCP subprocess that dials
 * the gateway. If that launch/connect fails the agent silently has no outbound
 * while still receiving inbound, so after every spawn we verify it actually
 * registered, using the gateway's registration signal (positive — the channel
 * server registers on a successful connect) rather than parsing daemon logs.
 *
 * The original check was ONE-SHOT at 30s, which declared permanent failure on
 * a transient state: a restart-all boot sweep routinely takes Claude Code past
 * 30s to launch its MCP subprocess (startup dialogs + a ~20-agent thundering
 * herd), which mass-produced a false "can't send messages" SystemWarning for
 * the entire resumed fleet on every server restart (2026-08-08 audit: 23 of
 * the 33 live panel notifications were this, and the log showed "never
 * registered" followed seconds later by the same agent connecting).
 *
 * Now: probe on an escalating schedule and warn only on the FINAL miss; if the
 * agent registers after we warned anyway, retract the notification and log the
 * correction — a stale warning the operator acts on is worse than no warning.
 *
 * Leaf module by design (mirrors promptDelivery.ts): runtime.ts injects the
 * probe/liveness/notify callbacks, gateway/router.ts reports the registration
 * edge via noteChannelServerRegistered. No imports from either, so no cycles.
 *
 * SCOPE: this catches a channel server that never LAUNCHES. It does NOT cover
 * a server that registers then later DROPS — but the channel-server subprocess
 * is a child of the app-server daemon, so the common cause (daemon death)
 * already surfaces via the A3 status watcher's "daemon unreachable" warning. A
 * standalone MCP-subprocess crash while the daemon survives is a known, narrow
 * follow-up gap (would need an edge-triggered warn on unexpected unregister).
 */

/** Cumulative looks at ~30s, ~90s, ~180s after spawn. */
export const CHANNEL_SERVER_PROBE_DELAYS_MS: readonly number[] = [
  30_000, 60_000, 90_000,
];

export interface ChannelServerCheckIO {
  /** Has this agent's channel server registered on the gateway?
   *  null/undefined = unknown (gateway not wired yet) — treated as "don't warn". */
  probe(): boolean | null | undefined;
  /** Is the spawn this check was armed for still the live attachment?
   *  False after a kill/respawn — the check silently stands down. */
  isLive(): boolean;
  /** Push the operator-facing warning; returns a retraction id. */
  notify(message: string): string;
  /** Withdraw a previously pushed warning. Returns false if already gone. */
  retract(notificationId: string): boolean;
  /** Test override for the probe schedule. */
  probeDelaysMs?: readonly number[];
}

interface Check {
  io: ChannelServerCheckIO;
  name: string;
  spawnedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Set once the final probe warned, so a late registration can retract. */
  warning?: { notificationId: string };
}

const checks = new Map<string, Check>();

/** Arm the post-spawn registration check for one agent. Re-arming replaces any
 *  prior check for the same id (kill/respawn paths also cancel explicitly). */
export function trackChannelServerRegistration(
  agentId: string,
  name: string,
  io: ChannelServerCheckIO,
): void {
  cancelChannelServerCheck(agentId);
  const check: Check = { io, name, spawnedAt: Date.now(), timer: null };
  checks.set(agentId, check);
  armProbe(agentId, check, 0);
}

function armProbe(agentId: string, check: Check, attempt: number): void {
  const delays = check.io.probeDelaysMs ?? CHANNEL_SERVER_PROBE_DELAYS_MS;
  check.timer = setTimeout(() => {
    check.timer = null;
    if (!check.io.isLive()) {
      checks.delete(agentId); // killed/replaced — not our spawn
      return;
    }
    if (check.io.probe() !== false) {
      checks.delete(agentId); // registered or unknown — quietly done
      return;
    }
    if (attempt + 1 < delays.length) {
      armProbe(agentId, check, attempt + 1); // still unregistered — look again
      return;
    }
    // Final miss. Server-log breadcrumb (with the id) for cold debugging — the
    // user-facing SystemWarning deliberately omits the raw id.
    const waitedMs = Date.now() - check.spawnedAt;
    console.warn(
      `[runtime] ${agentId.slice(0, 8)} channel server never registered within ${waitedMs}ms (${delays.length} probes) — outbound (send + org tools) unavailable`,
    );
    const notificationId = check.io.notify(
      `${check.name} can't send messages — its autonomos channel server never registered on the gateway (it either failed to launch or couldn't connect/authenticate), so send() and the org tools are unavailable. It can still receive inbound.`,
    );
    // Keep the (timerless) entry so a late registration can retract.
    check.warning = { notificationId };
  }, delays[attempt]);
  check.timer.unref?.();
}

/**
 * Registration edge from the gateway — called on every channel-server connect.
 * Pending probes stand down quietly; if the probes had already given up and
 * warned, the warning was premature: retract it and say so in the log, so the
 * operator isn't chasing an outbound failure that healed itself.
 */
export function noteChannelServerRegistered(agentId: string): void {
  const check = checks.get(agentId);
  if (!check) return;
  checks.delete(agentId);
  if (check.timer) clearTimeout(check.timer);
  if (check.warning) {
    const afterMs = Date.now() - check.spawnedAt;
    const retracted = check.io.retract(check.warning.notificationId);
    console.log(
      `[runtime] ${agentId.slice(0, 8)} channel server registered after ${afterMs}ms — earlier "can't send messages" warning ${retracted ? "retracted" : "already gone"}`,
    );
  }
}

/** Dispose one agent's check (kill/exit/delete). Safe on untracked ids. */
export function cancelChannelServerCheck(agentId: string): void {
  const check = checks.get(agentId);
  if (check) {
    if (check.timer) clearTimeout(check.timer);
    checks.delete(agentId);
  }
}

/** Dispose all checks (restart-all / shutdown). */
export function cancelAllChannelServerChecks(): void {
  for (const check of checks.values()) {
    if (check.timer) clearTimeout(check.timer);
  }
  checks.clear();
}
