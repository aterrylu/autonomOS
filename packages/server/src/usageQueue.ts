/**
 * Usage queue — auto-press Enter in a terminal pane the next time the Claude
 * usage limit clears.
 *
 * The motivating workflow: you hit 100% usage, type your next prompt into
 * Claude Code's input box, and it just sits there because you're capped. You
 * arm this queue on the pane; hours later — whenever the limit actually lifts —
 * the server injects a single carriage return, submitting whatever's typed. No
 * dashboard needs to be open.
 *
 * Why the server owns this (not the dashboard): the trigger has to fire while
 * you're away, with no browser tab watching. The server already holds the PTYs
 * (see {@link ./agents/runtime}) and can poll usage itself
 * (see {@link ./plugins/claude-usage/scanner}), so it's the only place the
 * fire can be guaranteed.
 *
 * Why poll, not schedule: claude.ai clears/refreshes limits unpredictably —
 * sometimes earlier than the advertised `resetsAt`. A timer armed to a
 * timestamp would fire into a still-capped limit, or miss an early clear. So
 * instead we watch actual utilization and fire on the observed high→low edge.
 * The reset timestamp is only ever a UI hint, never the trigger.
 *
 * The detector is account-wide (a single shared poll) because the usage limit
 * is account-wide — N armed panes share one signal. Hysteresis (enter ≥ 90,
 * exit < 80) keeps a utilization that hovers near the cap from flapping the
 * blocked state. Each armed pane latches `seenBlocked` while blocked and fires
 * the instant blocked goes false — which cleanly handles arming *while* capped
 * (latches immediately, fires on clear) and arming *before* capped (waits,
 * latches when you hit the wall, fires when it lifts), and never fires for a
 * pane that was never blocked.
 *
 * Because the fire happens while nobody's watching, every way the queue can
 * fail to deliver is routed to {@link UsageQueueDeps.notify} (the same
 * SystemWarning path promptDelivery uses) so a silent drop still reaches the
 * dashboard notification panel.
 */

import type { UUID } from "@autonomos/core";
import { getAttachment } from "./agents/runtime.js";
import type {
  RateLimitData,
  RateLimitWindow,
} from "./plugins/claude-usage/scanner.js";
import { getRateLimits } from "./plugins/claude-usage/scanner.js";
import { pushSystemNotification } from "./routes/hooks.js";

/** Utilization% (0–100) at/above which a window counts as blocking. */
const CAP_ENTER = 90;
/** Utilization% below which a blocking window is considered cleared. The gap
 * to {@link CAP_ENTER} is hysteresis — a real reset drops to ~0, so this
 * margin only matters to suppress noise, never to delay a genuine clear. */
const CAP_EXIT = 80;
/** How often the shared watcher polls usage while any pane is armed. Matches
 * the scanner's own 60s cache, so polling faster would just re-read cache. */
const DEFAULT_INTERVAL_MS = 60_000;
/** The submit keystroke. xterm.js sends Enter as a carriage return, and the
 * server writes client bytes straight to the PTY, so this is byte-identical to
 * the user pressing Enter (see also providers/claude-code auto-trust). */
const SUBMIT_KEY = "\r";

export interface UsageQueueDeps {
  /** Fetch the current rate-limit snapshot. */
  getUsage: () => Promise<RateLimitData>;
  /** Submit (press Enter) in a pane. Returns false when the PTY is gone. */
  sendSubmit: (sessionId: string) => boolean;
  /** Poll cadence; defaults to {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Optional sink for one-line activity logs. */
  log?: (message: string) => void;
  /** Surface a server-originated warning against a pane. The queue fires while
   * nobody's watching, so every undeliverable outcome (PTY gone on clear,
   * usage permanently unreadable) goes here to reach the dashboard. */
  notify?: (sessionId: string, message: string) => void;
  /** Evaluate usage immediately on arm (default true). Without it, arming
   * *while* capped would miss a clear that lands inside the first poll
   * interval. Tests set false to drive {@link UsageQueue.tick} deterministically
   * instead of racing arm's fire-and-forget evaluation. */
  evaluateOnArm?: boolean;
}

/** What the dashboard reads to render the per-pane button + ETA hint. */
export interface UsageQueueStatus {
  /** Session IDs with an armed auto-send. */
  armed: string[];
  /** Whether the account is currently usage-blocked (hysteresis-smoothed). */
  blocked: boolean;
  /** Nearest reset timestamp among currently-blocking windows, for a UI ETA.
   * Null when not blocked or unknown. The fire does NOT wait for this. */
  resetsAt: string | null;
}

interface ArmedEntry {
  armedAt: number;
  /** True once the watcher has observed the account blocked since this pane
   * armed. Gates firing so a never-blocked pane never auto-submits. */
  seenBlocked: boolean;
}

export interface UsageQueue {
  arm(sessionId: string): void;
  disarm(sessionId: string): void;
  isArmed(sessionId: string): boolean;
  status(): UsageQueueStatus;
  /** Run one poll/evaluate cycle. Exposed for deterministic tests. */
  tick(): Promise<void>;
  /** Stop the internal timer (tests / shutdown). */
  stop(): void;
}

/**
 * Build a usage queue over injected dependencies. The default singleton
 * ({@link usageQueue}) wires these to the real scanner + PTY registry; tests
 * inject fakes and drive {@link UsageQueue.tick} by hand for determinism.
 */
export function createUsageQueue(deps: UsageQueueDeps): UsageQueue {
  const armed = new Map<string, ArmedEntry>();
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = deps.log ?? (() => {});

  let blocked = false;
  let resetsAt: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard. `tick()` suspends at `await getUsage()`, and it's
   * driven from both the interval timer and arm's immediate evaluation. Without
   * this, two ticks could resume on the same just-cleared account and each call
   * `sendSubmit` before either ran `armed.delete` — a double Enter, the worst
   * failure mode. The delete makes sequential ticks idempotent; this closes the
   * concurrent-overlap gap. */
  let ticking = false;
  /** One-shot latch so a persistent credential failure warns once, not every
   * tick. Cleared whenever a real usage signal returns. */
  let authFailureNotified = false;

  function liveWindows(data: RateLimitData): RateLimitWindow[] {
    return [
      data.fiveHour,
      data.sevenDay,
      data.sevenDaySonnet,
      data.sevenDayOpus,
    ].filter((w): w is RateLimitWindow => w != null);
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    if (armed.size === 0) return;
    ticking = true;
    try {
      let data: RateLimitData;
      try {
        data = await deps.getUsage();
      } catch (err) {
        // The scanner returns transient failures as data (error/errorKind), so
        // a thrown exception is genuinely unexpected — log it rather than
        // silently assuming "transient, retry forever," which would hide a real
        // fault while the queue spins and never fires.
        log(
          `[usage-queue] getUsage threw (holding state): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }

      const windows = liveWindows(data);
      if (windows.length === 0) {
        // No window data. A permanent credential failure means the queue can
        // NEVER fire — warn each armed pane once so a multi-hour wait isn't
        // silent. A transient/no-data gap just holds quietly and retries.
        if (data.errorKind === "unauthorized" || data.errorKind === "no_org") {
          if (!authFailureNotified) {
            authFailureNotified = true;
            for (const sessionId of armed.keys()) {
              deps.notify?.(
                sessionId,
                `Usage queue can't read your Claude usage (${data.errorKind}). Queued auto-sends will NOT fire until you re-authenticate.`,
              );
            }
          }
        } else {
          log(
            `[usage-queue] no usage signal (${data.errorKind ?? "no data"}) — holding`,
          );
        }
        return;
      }
      // Real signal again — re-arm the one-shot credential warning.
      authFailureNotified = false;

      const maxUtil = Math.max(...windows.map((w) => w.utilization));
      // Hysteresis edge: only the transition matters, and the wide enter/exit
      // band means a near-cap wobble can't toggle it.
      if (!blocked && maxUtil >= CAP_ENTER) blocked = true;
      else if (blocked && maxUtil < CAP_EXIT) blocked = false;

      // Nearest reset among windows still near the cap — purely a UI ETA hint.
      const blocking = windows
        .filter((w) => w.utilization >= CAP_EXIT)
        .map((w) => w.resetsAt)
        .filter((r): r is string => !!r)
        .sort();
      resetsAt = blocking[0] ?? null;

      if (blocked) {
        for (const entry of armed.values()) entry.seenBlocked = true;
        return;
      }

      // Unblocked: fire every pane that saw the block, all at once (the limit is
      // account-wide, so there's one shared clear event for all of them).
      const toFire = [...armed.entries()].filter(([, e]) => e.seenBlocked);
      for (const [sessionId] of toFire) {
        const sent = deps.sendSubmit(sessionId);
        armed.delete(sessionId);
        if (!sent) {
          // The one event the feature exists to catch happened, but the PTY was
          // gone (agent exited / server restarted). The drop is unavoidable — a
          // silent one would leave the user believing their prompt was sent.
          deps.notify?.(
            sessionId,
            "Usage limit cleared, but this pane was gone — your queued prompt was NOT submitted.",
          );
        }
        log(
          `[usage-queue] limit cleared → ${
            sent ? "sent Enter to" : "pane gone, dropped (user notified)"
          } ${sessionId}`,
        );
      }
      if (armed.size === 0) stop();
    } finally {
      ticking = false;
    }
  }

  function ensureTimer(): void {
    if (!timer && armed.size > 0) {
      timer = setInterval(() => void tick(), intervalMs);
      // Don't keep the process alive solely for this poll loop.
      timer.unref?.();
    }
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    arm(sessionId: string): void {
      armed.set(sessionId, { armedAt: Date.now(), seenBlocked: blocked });
      ensureTimer();
      // Evaluate immediately so the blocked/resetsAt hint is fresh right after
      // arming, and so arming while capped can't miss a clear that lands inside
      // the first poll interval. The re-entrancy guard keeps this safe against
      // a concurrent timer tick.
      if (deps.evaluateOnArm !== false) void tick();
    },
    disarm(sessionId: string): void {
      armed.delete(sessionId);
      if (armed.size === 0) stop();
    },
    isArmed(sessionId: string): boolean {
      return armed.has(sessionId);
    },
    status(): UsageQueueStatus {
      return { armed: [...armed.keys()], blocked, resetsAt };
    },
    tick,
    stop,
  };
}

let singleton: UsageQueue | null = null;

/** The process-wide usage queue, wired to the real scanner + PTY registry. */
export function usageQueue(): UsageQueue {
  if (!singleton) {
    singleton = createUsageQueue({
      getUsage: () => getRateLimits(),
      sendSubmit: (sessionId) => {
        const pty = getAttachment(sessionId as UUID)?.pty;
        if (!pty) return false;
        pty.write(SUBMIT_KEY);
        return true;
      },
      notify: (sessionId, message) =>
        pushSystemNotification(sessionId, message),
      log: (message) => console.log(message),
    });
  }
  return singleton;
}
