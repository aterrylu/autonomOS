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
 * agent proves registered after we warned anyway — via the gateway's
 * registration edge or a later spawn's probe — retract the notification and
 * log the correction. A stale warning the operator acts on is worse than no
 * warning, and the likeliest response to this one (respawn the agent) must
 * clear it, so an unretracted warning is CARRIED across a re-arm and settled
 * by the replacement spawn's outcome.
 *
 * Leaf module by design (mirrors promptDelivery.ts): runtime.ts injects the
 * probe/liveness/notify callbacks, gateway/router.ts reports the registration
 * edge via noteChannelServerRegistered. No imports from either, so no cycles.
 *
 * SCOPE: this catches a channel server that never LAUNCHES. It does NOT cover
 * a server that registers then later DROPS. For Codex the subprocess is a
 * child of the app-server daemon, so the common drop cause (daemon death)
 * surfaces via the A3 status watcher's "daemon unreachable" warning; for
 * Claude Code and Gemini the subprocess is a child of the CLI and a
 * post-registration drop is currently UNWARNED — a known, narrow follow-up
 * gap (would need an edge-triggered warn on unexpected unregister). Also:
 * cancelAllChannelServerChecks (restart-all/shutdown) drops unretracted
 * warnings with the checks, so a warning emitted just before a sweep is not
 * retractable by the respawned agent — accepted, since the sweep itself
 * re-arms fresh checks that warn again if the condition is real.
 */

/** Cumulative looks at ~30s, ~90s, ~180s after spawn. */
export const CHANNEL_SERVER_PROBE_DELAYS_MS: readonly number[] = [
  30_000, 60_000, 90_000,
];

export interface ChannelServerCheckIO {
  /** Has this agent's channel server registered on the gateway?
   *  null/undefined = unknown (gateway not wired yet). */
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
  /** Warnings not yet retracted — this spawn's final-miss warning and any
   *  carried over from a replaced spawn. Settled (retracted) the moment the
   *  agent proves registered; dropped only on kill/shutdown. */
  warnedNotificationIds: string[];
}

const checks = new Map<string, Check>();

/** Arm the post-spawn registration check for one agent. Re-arming replaces any
 *  prior check for the same id but CARRIES its unretracted warning, so the
 *  replacement spawn's success can clear it (kill/exit paths cancel instead). */
export function trackChannelServerRegistration(
  agentId: string,
  name: string,
  io: ChannelServerCheckIO,
): void {
  const carried = checks.get(agentId)?.warnedNotificationIds ?? [];
  cancelChannelServerCheck(agentId);
  const check: Check = {
    io,
    name,
    spawnedAt: Date.now(),
    timer: null,
    warnedNotificationIds: carried,
  };
  checks.set(agentId, check);
  armProbe(agentId, check, 0);
}

function armProbe(agentId: string, check: Check, attempt: number): void {
  const delays = check.io.probeDelaysMs ?? CHANNEL_SERVER_PROBE_DELAYS_MS;
  check.timer = setTimeout(() => {
    check.timer = null;
    // The IO callbacks are injected; a throw here would escape into the timer
    // tick AND strand the check in silence. This module's whole job is being
    // the last-resort detector, so it fails loudly instead.
    try {
      if (!check.io.isLive()) {
        checks.delete(agentId); // killed/replaced — not our spawn
        return;
      }
      const registered = check.io.probe();
      if (registered === true) {
        resolveRegistered(agentId, check, "probe");
        return;
      }
      if (attempt + 1 < delays.length) {
        armProbe(agentId, check, attempt + 1); // false OR unknown — look again
        return;
      }
      if (registered !== false) {
        // Unknown at the final probe (gateway never wired): can't prove
        // failure, so no warning — but keep any carried warning entry so a
        // late registration edge can still retract it.
        if (check.warnedNotificationIds.length === 0) checks.delete(agentId);
        return;
      }
      // Final miss. Server-log breadcrumb (with the id) for cold debugging —
      // the user-facing SystemWarning deliberately omits the raw id.
      const waitedMs = Date.now() - check.spawnedAt;
      console.warn(
        `[runtime] ${agentId.slice(0, 8)} channel server never registered within ${waitedMs}ms (${delays.length} probes) — outbound (send + org tools) unavailable`,
      );
      const notificationId = check.io.notify(
        `${check.name} can't send messages — its autonomos channel server never registered on the gateway (it either failed to launch or couldn't connect/authenticate), so send() and the org tools are unavailable. It can still receive inbound.`,
      );
      // Keep the (timerless) entry so a late registration can retract.
      check.warnedNotificationIds.push(notificationId);
    } catch (err) {
      checks.delete(agentId);
      console.warn(
        `[runtime] ${agentId.slice(0, 8)} channel-server check threw — check abandoned:`,
        err instanceof Error ? err.message : err,
      );
    }
  }, delays[attempt]);
  check.timer.unref?.();
}

/** The agent is proven registered: stand down and retract any outstanding
 *  warning (this spawn's or one carried from a replaced spawn). */
function resolveRegistered(
  agentId: string,
  check: Check,
  via: "probe" | "edge",
): void {
  checks.delete(agentId);
  if (check.timer) clearTimeout(check.timer);
  if (check.warnedNotificationIds.length === 0) return;
  let retracted = 0;
  for (const id of check.warnedNotificationIds) {
    try {
      if (check.io.retract(id)) retracted++;
    } catch (err) {
      console.warn(
        `[runtime] ${agentId.slice(0, 8)} warning retraction threw:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  const afterMs = Date.now() - check.spawnedAt;
  console.log(
    `[runtime] ${agentId.slice(0, 8)} channel server registered after ${afterMs}ms (${via}) — earlier "can't send messages" warning ${retracted > 0 ? "retracted" : "already gone"}`,
  );
}

/**
 * Registration edge from the gateway — called on every channel-server connect.
 * Pending probes stand down quietly; if the probes had already given up and
 * warned, the warning was premature: retract it and say so in the log, so the
 * operator isn't chasing an outbound failure that healed itself. No-op for
 * untracked agents (e.g. reconnects of long-registered ones).
 */
export function noteChannelServerRegistered(agentId: string): void {
  const check = checks.get(agentId);
  if (!check) return;
  if (check.warnedNotificationIds.length > 0) {
    resolveRegistered(agentId, check, "edge");
    return;
  }
  checks.delete(agentId);
  if (check.timer) clearTimeout(check.timer);
}

/** Dispose one agent's check (kill/exit/delete). Safe on untracked ids. An
 *  unretracted warning is dropped with the check — the agent is going away,
 *  so there is no future registration to prove it wrong. */
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
