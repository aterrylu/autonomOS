/**
 * Usage queue — auto-press Enter in a terminal pane the next time THAT PANE'S
 * runtime usage limit clears.
 *
 * The motivating workflow: you hit 100% usage, type your next prompt into the
 * agent's input box, and it just sits there because you're capped. You arm this
 * queue on the pane; hours later — whenever the limit actually lifts — the
 * server injects a single carriage return, submitting whatever's typed. No
 * dashboard needs to be open.
 *
 * PER-RUNTIME (ADR-068): each armed pane carries its agent's `provider`, and the
 * queue tracks cap state PER provider. A Claude Code pane waits on the Claude
 * account limit (claude-usage); a Codex pane waits on the Codex limit
 * (codex-usage); a Gemini pane has no rolling-window usage source, so it can't
 * arm at all. Previously the cap was account-wide Claude for EVERY pane, so a
 * Codex pane's button lit up on the Claude limit — the bug this fixes.
 *
 * Why the server owns this (not the dashboard): the trigger has to fire while
 * you're away, with no browser tab watching. The server already holds the PTYs
 * (see {@link ./agents/runtime}) and can poll usage itself, so it's the only
 * place the fire can be guaranteed.
 *
 * Why poll, not schedule: limits clear/refresh unpredictably — sometimes earlier
 * than the advertised reset. A timer armed to a timestamp would fire into a
 * still-capped limit, or miss an early clear. So we watch actual utilization and
 * fire on the observed high→low edge. The reset timestamp is only a UI hint.
 *
 * The detector is per-provider-account-wide (one shared poll per provider,
 * because each provider's limit is account-wide) — N armed panes of the same
 * provider share its signal. Hysteresis (enter ≥ 90, exit < 80) keeps a
 * utilization hovering near the cap from flapping. Each armed pane latches
 * `seenBlocked` while ITS provider is blocked and fires the instant that goes
 * false — handling arm-while-capped (latch now, fire on clear) and
 * arm-before-capped (wait, latch at the wall, fire when it lifts), and never
 * firing for a pane whose provider was never blocked.
 *
 * Every way the queue can fail to deliver is routed to {@link
 * UsageQueueDeps.notify} (the SystemWarning path) so a silent drop still reaches
 * the dashboard notification panel.
 */

import type { Provider, UUID } from "@autonomos/core";
import { getAttachment } from "./agents/runtime.js";
import type {
  RateLimitData,
  RateLimitWindow,
} from "./plugins/claude-usage/scanner.js";
import { getRateLimits } from "./plugins/claude-usage/scanner.js";
import { getCodexUsage } from "./plugins/codex-usage/scanner.js";
import type {
  CodexUsageData,
  CodexUsageWindow,
} from "./plugins/codex-usage/types.js";
import { pushSystemNotification } from "./routes/hooks.js";

/** Utilization% (0–100) at/above which a window counts as blocking. */
const CAP_ENTER = 90;
/** Utilization% below which a blocking window is considered cleared. The gap to
 * {@link CAP_ENTER} is hysteresis — a real reset drops to ~0, so this margin
 * only suppresses noise, never delays a genuine clear. */
const CAP_EXIT = 80;
/** How often the shared watcher polls usage while any pane is armed. The
 * scanners cache upstream (Claude 180s, Codex 60s), so polling faster than the
 * shortest TTL would just re-read cache; 60s keeps the Codex edge prompt while
 * Claude advances every third tick. */
const DEFAULT_INTERVAL_MS = 60_000;
/** The submit keystroke. xterm.js sends Enter as a carriage return, and the
 * server writes client bytes straight to the PTY, so this is byte-identical to
 * the user pressing Enter. */
const SUBMIT_KEY = "\r";

// ── Normalized usage (provider-agnostic) ──────────────────────────
// The queue reasons over this shape; per-provider adapters (bottom of file)
// bridge each plugin's snapshot onto it. Keeping the core plugin-agnostic is
// what lets createUsageQueue be unit-tested with injected fake probes.

export interface NormalizedWindow {
  utilization: number;
  resetsAt: string | null;
  /** Human label for WHICH limit this is ("5h", "Sonnet 7d", a Codex named
   * limit…). Carried so cap reads can tell the user which window is capping —
   * the status bar shows only the headline windows, so a cap on a window it
   * doesn't render (e.g. a per-model weekly) is otherwise invisible. */
  label: string;
}
export interface NormalizedUsage {
  windows: NormalizedWindow[];
  /** Set when the signal is unreadable for a CREDENTIAL reason (which never
   * clears on its own) — armed panes get warned once. A transient/no-data gap
   * leaves this unset so the queue just holds quietly and retries. */
  authError?: boolean;
}

/** A provider's usage probe. Returns the normalized snapshot (cached upstream). */
export type UsageProbe = () => Promise<NormalizedUsage>;

export interface CapStatus {
  capped: boolean;
  resetsAt: string | null;
  /** Label of the highest-utilization blocking window when capped (null when
   * not capped) — so the button can say WHICH limit was hit. */
  window: string | null;
}

/** The window driving the cap — highest utilization, first one on a tie. Null
 * only for an empty snapshot (no readable signal). */
function topWindow(windows: NormalizedWindow[]): NormalizedWindow | null {
  return windows.reduce<NormalizedWindow | null>(
    (best, w) => (best && best.utilization >= w.utilization ? best : w),
    null,
  );
}

/** Earliest reset among the windows at/near the cap — an ETA hint only; the
 * queue fires on the observed high→low edge, never on this timestamp. */
function nearestBlockingReset(windows: NormalizedWindow[]): string | null {
  return (
    windows
      .filter((w) => w.utilization >= CAP_EXIT)
      .map((w) => w.resetsAt)
      .filter((r): r is string => !!r)
      .sort()[0] ?? null
  );
}

/**
 * Stateless read of whether a snapshot is at/over the cap, and the nearest
 * blocking reset (for an ETA). Unlike the watcher's hysteresis `blocked` — which
 * only advances while a pane is armed — this is computed fresh from any
 * snapshot, so the route can decide button visibility ("show only at the limit")
 * per provider before anything is armed.
 */
export function evaluateCap(usage: NormalizedUsage): CapStatus {
  const top = topWindow(usage.windows);
  if (!top) return { capped: false, resetsAt: null, window: null };
  const capped = top.utilization >= CAP_ENTER;
  return {
    capped,
    resetsAt: nearestBlockingReset(usage.windows),
    window: capped ? top.label : null,
  };
}

export interface UsageQueueDeps {
  /** One probe per provider that HAS a usage limit. A provider absent here
   * (e.g. gemini-cli — no rolling window) cannot be armed. */
  probes: Partial<Record<Provider, UsageProbe>>;
  /** Submit (press Enter) in a pane. Returns false when the PTY is gone. */
  sendSubmit: (sessionId: string) => boolean;
  /** Poll cadence; defaults to {@link DEFAULT_INTERVAL_MS}. */
  intervalMs?: number;
  /** Optional sink for one-line activity logs. */
  log?: (message: string) => void;
  /** Surface a server-originated warning against a pane. */
  notify?: (sessionId: string, message: string) => void;
  /** Evaluate usage immediately on arm (default true). */
  evaluateOnArm?: boolean;
}

/** What the dashboard reads to render the per-pane button + ETA hint. */
export interface UsageQueueStatus {
  /** Session IDs with an armed auto-send. */
  armed: string[];
  /** The watcher's per-provider cap view (only advances while a pane of that
   * provider is armed). The route serves FRESH per-provider caps for pre-arm
   * visibility; this reflects what the live watcher currently sees. */
  caps: Record<string, CapStatus>;
}

interface ArmedEntry {
  /** The agent's runtime — selects which provider's usage this pane waits on. */
  provider: Provider;
  armedAt: number;
  /** True once the watcher has observed THIS pane's provider blocked since it
   * armed. Gates firing so a never-blocked pane never auto-submits. */
  seenBlocked: boolean;
  /** True once this pane has been warned about a permanent credential failure.
   * Per-pane so a pane armed AFTER the first warning still gets told. Reset when
   * a real usage signal returns. */
  authWarned: boolean;
}

export interface UsageQueue {
  /** Arm a pane against its agent's runtime. A provider with no usage source
   * (gemini) is ignored (logged) — there is nothing to wait on. */
  arm(sessionId: string, provider: Provider): void;
  disarm(sessionId: string): void;
  isArmed(sessionId: string): boolean;
  status(): UsageQueueStatus;
  /** Run one poll/evaluate cycle. Exposed for deterministic tests. */
  tick(): Promise<void>;
  /** Stop the internal timer (tests / shutdown). */
  stop(): void;
}

/** Human label for a provider, for notifications. */
function providerLabel(p: Provider): string {
  if (p === "claude-code") return "Claude";
  if (p === "codex") return "Codex";
  return p;
}

/**
 * Build a usage queue over injected dependencies. The default singleton
 * ({@link usageQueue}) wires the real per-provider probes + PTY registry; tests
 * inject fakes and drive {@link UsageQueue.tick} by hand for determinism.
 */
export function createUsageQueue(deps: UsageQueueDeps): UsageQueue {
  const armed = new Map<string, ArmedEntry>();
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const log = deps.log ?? (() => {});

  // Per-provider hysteresis state — advances only while a pane of that provider
  // is armed (the watcher polls a provider only when it has armed panes).
  const blocked = new Map<Provider, boolean>();
  const resetsAt = new Map<Provider, string | null>();
  const capWindow = new Map<Provider, string | null>();

  let timer: ReturnType<typeof setInterval> | null = null;
  /** Re-entrancy guard — two ticks resuming on the same just-cleared account
   * could each sendSubmit before either ran armed.delete. One guard for the
   * whole tick keeps it safe. */
  let ticking = false;

  /** Evaluate + fire ONE provider's armed panes. */
  async function tickProvider(
    provider: Provider,
    entries: Array<[string, ArmedEntry]>,
  ): Promise<void> {
    const probe = deps.probes[provider];
    if (!probe) return; // no usage source — panes of this provider never fire.

    let usage: NormalizedUsage;
    try {
      usage = await probe();
    } catch (err) {
      // Probes return transient failures as data (authError / empty windows), so
      // a THROW is genuinely unexpected — log rather than silently spin forever.
      log(
        `[usage-queue] ${provider} probe threw (holding): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    const top = topWindow(usage.windows);
    if (!top) {
      if (usage.authError) {
        // Permanent credential failure → this provider's queue can NEVER fire.
        // Warn each of its armed panes once so a multi-hour wait isn't silent.
        for (const [sessionId, entry] of entries) {
          if (entry.authWarned) continue;
          entry.authWarned = true;
          deps.notify?.(
            sessionId,
            `Usage queue can't read your ${providerLabel(provider)} usage — queued auto-sends will NOT fire until you re-authenticate.`,
          );
        }
      } else {
        log(`[usage-queue] no ${provider} usage signal — holding`);
      }
      return;
    }
    // Real signal again — re-arm each pane's one-shot credential warning.
    for (const [, entry] of entries) entry.authWarned = false;

    const maxUtil = top.utilization;
    let isBlocked = blocked.get(provider) ?? false;
    if (!isBlocked && maxUtil >= CAP_ENTER) isBlocked = true;
    else if (isBlocked && maxUtil < CAP_EXIT) isBlocked = false;
    blocked.set(provider, isBlocked);
    // While blocked — INCLUDING the hysteresis band — name the current top
    // window: it is the one holding the block even if it has dipped below
    // CAP_ENTER. This deliberately differs from evaluateCap, which is a
    // stateless read and only ever names a window at/over the threshold.
    capWindow.set(provider, isBlocked ? top.label : null);
    resetsAt.set(provider, nearestBlockingReset(usage.windows));

    if (isBlocked) {
      for (const [, entry] of entries) entry.seenBlocked = true;
      return;
    }

    // Cleared: fire every pane of this provider that saw the block (one shared
    // clear event for all of them).
    for (const [sessionId, entry] of entries) {
      if (!entry.seenBlocked) continue;
      const sent = deps.sendSubmit(sessionId);
      armed.delete(sessionId);
      if (!sent) {
        deps.notify?.(
          sessionId,
          "Usage limit cleared, but this pane was gone — your queued prompt was NOT submitted.",
        );
      }
      log(
        `[usage-queue] ${provider} limit cleared → ${
          sent ? "sent Enter to" : "pane gone, dropped (user notified)"
        } ${sessionId}`,
      );
    }
  }

  async function tick(): Promise<void> {
    if (ticking) return;
    if (armed.size === 0) return;
    ticking = true;
    try {
      // Group armed panes by provider; poll each provider that has any.
      const byProvider = new Map<Provider, Array<[string, ArmedEntry]>>();
      for (const [sessionId, entry] of armed) {
        const arr = byProvider.get(entry.provider) ?? [];
        arr.push([sessionId, entry]);
        byProvider.set(entry.provider, arr);
      }
      for (const [provider, entries] of byProvider) {
        await tickProvider(provider, entries);
      }
      if (armed.size === 0) stop();
    } finally {
      ticking = false;
    }
  }

  function ensureTimer(): void {
    if (!timer && armed.size > 0) {
      timer = setInterval(() => void tick(), intervalMs);
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
    arm(sessionId: string, provider: Provider): void {
      if (!deps.probes[provider]) {
        // Gemini (or any provider without a rolling-window usage source): there
        // is nothing to wait on, so arming is a no-op. The dashboard also hides
        // the button for these, so this is just defense at the boundary.
        log(
          `[usage-queue] ${provider} has no usage source — arm ignored for ${sessionId}`,
        );
        return;
      }
      armed.set(sessionId, {
        provider,
        armedAt: Date.now(),
        seenBlocked: blocked.get(provider) ?? false,
        authWarned: false,
      });
      ensureTimer();
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
      const caps: Record<string, CapStatus> = {};
      for (const [provider, isBlocked] of blocked) {
        caps[provider] = {
          capped: isBlocked,
          resetsAt: resetsAt.get(provider) ?? null,
          window: capWindow.get(provider) ?? null,
        };
      }
      return { armed: [...armed.keys()], caps };
    },
    tick,
    stop,
  };
}

// ── Per-provider probe adapters ───────────────────────────────────
// Bridge each plugin's snapshot onto NormalizedUsage. Exported so the route can
// compute FRESH per-provider caps (pre-arm button visibility) with the same
// mapping the watcher uses.

/** Claude: the four rolling windows → normalized, labeled as the UI names them. */
export function normalizeClaudeUsage(d: RateLimitData): NormalizedUsage {
  const entries: Array<[RateLimitWindow | null, string]> = [
    [d.fiveHour, "5h"],
    [d.sevenDay, "7d"],
    [d.sevenDaySonnet, "Sonnet 7d"],
    [d.sevenDayOpus, "Opus 7d"],
  ];
  const windows = entries
    .filter((e): e is [RateLimitWindow, string] => e[0] != null)
    .map(([w, label]) => ({
      utilization: w.utilization,
      resetsAt: w.resetsAt,
      label,
    }));
  return {
    windows,
    // stale_token included: an expired Claude Code OAuth token can never clear
    // on its own (ADR-048 forbids refreshing it), so an armed pane must be
    // WARNED, not left holding silently. Codex has always treated it this way.
    authError:
      d.errorKind === "unauthorized" ||
      d.errorKind === "no_org" ||
      d.errorKind === "stale_token",
  };
}

/** Codex window label from its advertised length ("5h", "7d", "90m"). */
function codexWindowLabel(minutes: number): string {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

/** Codex: primary/secondary + any named limits → normalized (usedPercent → util). */
export function normalizeCodexUsage(d: CodexUsageData): NormalizedUsage {
  const authError =
    d.errorKind === "unauthorized" || d.errorKind === "stale_token";
  // Only a LIVE /wham/usage reading drives the queue's high→low edge. The
  // on-disk rollout is a FROZEN snapshot that only advances when the Codex CLI
  // runs a turn — which a capped or logged-out agent won't do — so trusting its
  // number would latch an armed pane at "capped" forever with no clear to fire
  // on (Nox). Treat non-live as "no signal": the queue holds (exactly like the
  // Claude no-data case), and still warns if it's a credential failure.
  if (d.source !== "live") return { windows: [], authError };
  // Headline windows first, then every named limit's primary, then every named
  // limit's secondary. Order is the tie-break when two windows read equal, so a
  // primary wins the cap label over an equally-loaded secondary.
  const raw: Array<{ w: CodexUsageWindow | null; name?: string }> = [
    { w: d.primary },
    { w: d.secondary },
    ...d.additionalLimits.map((l) => ({ w: l.primary, name: l.name })),
    ...d.additionalLimits.map((l) => ({ w: l.secondary, name: l.name })),
  ];
  const windows = raw
    .filter((x): x is { w: CodexUsageWindow; name?: string } => x.w != null)
    .map(({ w, name }) => ({
      utilization: w.usedPercent,
      resetsAt: w.resetsAt,
      label: name
        ? `${name} ${codexWindowLabel(w.windowMinutes)}`
        : codexWindowLabel(w.windowMinutes),
    }));
  return { windows, authError };
}

/** The real per-provider probes (cached upstream by each scanner). Exported so
 * the route reuses them for fresh cap reads. Gemini has no entry — no window. */
export const REAL_PROBES: Partial<Record<Provider, UsageProbe>> = {
  "claude-code": async () => normalizeClaudeUsage(await getRateLimits()),
  codex: async () => normalizeCodexUsage(await getCodexUsage()),
};

let singleton: UsageQueue | null = null;

/** The process-wide usage queue, wired to the real per-provider probes + PTYs. */
export function usageQueue(): UsageQueue {
  if (!singleton) {
    singleton = createUsageQueue({
      probes: REAL_PROBES,
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
