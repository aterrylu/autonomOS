/**
 * Prompt delivery receipt tracking — fallback re-delivery for starting prompts.
 *
 * When an agent is spawned WITH a starting prompt, the prompt travels only as
 * a CLI arg (`claude ... -- <prompt>`). If a startup dialog (trust/channels)
 * races the TUI's stdin attach, the queued prompt can silently never submit —
 * the agent sits at an empty input box forever while its creator waits.
 *
 * This module watches the hook-event stream for a delivery receipt:
 *
 *   spawn(prompt) → [startup settles] → SessionStart → UserPromptSubmit  ✓
 *
 * TIMING IS SETTLE-GATED (2026-08-08 audit). The original fixed 15s/20s
 * windows measured from spawn/SessionStart raced Claude Code's TUI startup —
 * under a multi-agent boot sweep the argv-queued prompt routinely takes >40s
 * to submit, so EVERY worker spawn produced "prompt was likely dropped" +
 * "agent may be stuck" warnings for agents that were fine, and the paste
 * fallback DOUBLE-DELIVERED the prompt (the audit agent received its own
 * brief twice: once from the CLI arg, once from the paste that had queued in
 * the PTY buffer behind the booting TUI). Now:
 *
 *   - No window starts until the provider's startup watcher reports the
 *     startup dialogs settled (auto-trust done/given up — runtime wires
 *     {@link noteStartupSettled}); a fallback timer self-settles in case no
 *     watcher is attached, so the detector can never be silently disabled.
 *   - The submit window is minutes-scale (settle → submit latency is TUI +
 *     plugin boot, not model latency), so a slow boot confirms instead of
 *     pasting a duplicate into a TUI that still holds the original.
 *   - Giving up is RETRACTABLE: the tracker lingers after a failure warning,
 *     and a late receipt retracts the warning and logs the correction — a
 *     stale "needs a manual nudge" the operator acts on is worse than none.
 *
 * If SessionStart arrives but UserPromptSubmit never follows, the prompt is
 * re-delivered ONCE via PTY bracketed paste + Enter. Any sign of activity
 * (tool use, Stop, etc.) counts as proof the prompt ran and cancels the
 * fallback — double-submission is worse than a manual nudge.
 *
 * Leaf module by design: runtime.ts injects the PTY writer, routes/hooks.ts
 * feeds events in. No imports from either, so no cycles.
 *
 * The whole mechanism is hook-relay-shaped, so it applies only to providers
 * that HAVE a hook relay — see supportsPromptDeliveryReceipt().
 */

import type { ProviderCapabilities } from "@autonomos/core";

/**
 * Can this provider's prompt delivery be tracked at all?
 *
 * Every signal here (SessionStart, UserPromptSubmit, the activity events that
 * cancel the fallback) arrives through the hook relay. A provider that emits
 * no hook events can never produce a receipt, so tracking it guarantees the
 * timeout fires: Codex derives status from its app-server event stream and has
 * `eventCount: 0`, which made EVERY prompted Codex agent log "may have failed
 * to boot" and push a SystemWarning — including agents that had already run
 * their prompt correctly. That false alarm actively misdirected a real
 * investigation.
 *
 * Gated on the CAPABILITY rather than the provider name so it stays correct if
 * Codex ever ships hooks (it would start being tracked automatically).
 *
 * See ADR-057 for the decision, the rejected alternatives, and the consequence
 * this leaves behind (Codex spawn-with-prompt has no delivery detector).
 */
export function supportsPromptDeliveryReceipt(
  capabilities: ProviderCapabilities,
): boolean {
  return capabilities.hooks.eventCount > 0;
}

/** No SessionStart within this window OF STARTUP SETTLING → warn, hold for
 *  retraction. Measured from settle, not spawn: the trust dialog gates session
 *  creation itself, so a spawn-anchored clock just measures auto-trust. */
export const SESSION_START_TIMEOUT_MS = 30_000;
/**
 * No UserPromptSubmit within this window of BOTH SessionStart and settle →
 * re-deliver. Minutes-scale on purpose: what this window really measures is
 * TUI + plugin boot latency (the argv prompt submits the moment the input
 * attaches), and a boot-sweep host routinely needs >40s. A premature paste is
 * a guaranteed duplicate; a late one only delays recovery of a genuinely
 * dropped prompt.
 */
export const PROMPT_SUBMIT_TIMEOUT_MS = 90_000;
/** Gap between writing the bracketed paste and the submitting Enter. */
const REDELIVER_ENTER_DELAY_MS = 150;
/** If no startup watcher ever reports settle (none attached, or a wiring
 *  regression), self-settle after this long so tracking always progresses.
 *  Comfortably past the watcher's own 30s hard deadline. */
const SETTLE_FALLBACK_MS = 45_000;
/** How long a given-up tracker lingers so a late receipt can retract the
 *  failure warning before the tracker is finally dropped. */
const GIVEN_UP_RETENTION_MS = 10 * 60_000;

export interface PromptDeliveryIO {
  /** Write raw data to the agent's PTY. Return false if the PTY is gone. */
  write(data: string): boolean;
  /** Surface an operator-visible note (e.g. dashboard notification). May
   *  return a retraction id (see retract). */
  notify?(message: string): string | undefined;
  /** Withdraw a previously pushed notification by the id notify returned —
   *  used when a late receipt proves a failure warning premature. */
  retract?(notificationId: string): boolean;
  /** Test overrides for the timing constants. */
  sessionStartTimeoutMs?: number;
  promptSubmitTimeoutMs?: number;
  redeliverEnterDelayMs?: number;
  settleFallbackMs?: number;
  givenUpRetentionMs?: number;
}

type Phase =
  | "awaiting_session_start"
  | "awaiting_prompt_submit"
  | "awaiting_redelivery_confirm"
  | "given_up"
  | "done";

interface Tracker {
  label: string;
  prompt: string;
  io: PromptDeliveryIO;
  phase: Phase;
  /** Startup dialogs settled (or the fallback elapsed) — windows may arm. */
  settled: boolean;
  timer: NodeJS.Timeout | null;
  enterTimer: NodeJS.Timeout | null;
  /** Retraction ids of failure-claim notifications, so a late receipt can
   *  withdraw them. The factual "was re-delivered" note is never retracted. */
  failureNotificationIds: string[];
}

/**
 * Events that confirm the prompt was submitted (UserPromptSubmit) or that the
 * session is demonstrably busy with a turn — either way, re-delivering would
 * risk a double submission, so tracking completes.
 */
const DELIVERY_CONFIRMING_EVENTS = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "PreCompact",
]);

const trackers = new Map<string, Tracker>();

/** notify is an injected callback firing inside timer callbacks — a throw
 *  there would be an uncaught exception at timer level. Never let it. */
function safeNotify(t: Tracker, message: string): string | undefined {
  try {
    const id = t.io.notify?.(message);
    return typeof id === "string" ? id : undefined;
  } catch (err) {
    console.warn(
      `[prompt-delivery] ${t.label} notify callback threw:`,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

function clearTimers(t: Tracker): void {
  if (t.timer) clearTimeout(t.timer);
  if (t.enterTimer) clearTimeout(t.enterTimer);
  t.timer = null;
  t.enterTimer = null;
}

function finish(sessionId: string): void {
  const t = trackers.get(sessionId);
  if (!t) return;
  clearTimers(t);
  t.phase = "done";
  trackers.delete(sessionId);
}

function armTimer(t: Tracker, ms: number, fn: () => void): void {
  if (t.timer) clearTimeout(t.timer);
  t.timer = setTimeout(fn, ms);
}

/**
 * Begin tracking delivery for a session spawned with a starting prompt.
 * Call immediately after the PTY spawn. Idempotency: re-tracking the same
 * session replaces the previous tracker.
 *
 * No warning window is armed yet — windows start at {@link noteStartupSettled}
 * (or the settle fallback), because every receipt signal is downstream of the
 * startup dialogs being out of the way.
 */
export function trackPromptDelivery(
  sessionId: string,
  label: string,
  prompt: string,
  io: PromptDeliveryIO,
): void {
  finish(sessionId); // replace any stale tracker for this id
  const tracker: Tracker = {
    label,
    prompt,
    io,
    phase: "awaiting_session_start",
    settled: false,
    timer: null,
    enterTimer: null,
    failureNotificationIds: [],
  };
  trackers.set(sessionId, tracker);

  // Fallback self-settle: if no watcher is attached (or its callback is lost
  // to a wiring regression), the detector must still run rather than silently
  // never warning again.
  armTimer(tracker, io.settleFallbackMs ?? SETTLE_FALLBACK_MS, () =>
    noteStartupSettled(sessionId),
  );
}

/**
 * Startup dialogs are out of the way (auto-trust finished, gave up, or was
 * never needed) — the receipt windows may start. Wired by runtime.ts from the
 * provider's startup watcher; called directly at spawn when no watcher runs.
 * No-op for untracked sessions and on repeats.
 */
export function noteStartupSettled(sessionId: string): void {
  const t = trackers.get(sessionId);
  if (!t || t.settled) return;
  t.settled = true;
  if (t.phase === "awaiting_session_start") {
    armTimer(t, t.io.sessionStartTimeoutMs ?? SESSION_START_TIMEOUT_MS, () =>
      giveUpNoSessionStart(sessionId),
    );
  } else if (t.phase === "awaiting_prompt_submit") {
    // SessionStart already arrived while dialogs were still being dismissed.
    armTimer(t, t.io.promptSubmitTimeoutMs ?? PROMPT_SUBMIT_TIMEOUT_MS, () =>
      redeliver(sessionId),
    );
  }
}

function giveUpNoSessionStart(sessionId: string): void {
  const t = trackers.get(sessionId);
  if (!t || t.phase !== "awaiting_session_start") return;
  console.warn(
    `[prompt-delivery] ${t.label} no SessionStart within ` +
      `${t.io.sessionStartTimeoutMs ?? SESSION_START_TIMEOUT_MS}ms of startup settling — ` +
      `cannot confirm prompt delivery; skipping fallback (agent may have failed to boot)`,
  );
  const id = safeNotify(
    t,
    "Agent never reported SessionStart — it may be stuck on a startup dialog. Open its terminal and check.",
  );
  if (id) t.failureNotificationIds.push(id);
  enterGivenUp(sessionId, t);
}

/** Park the tracker so a late receipt can retract the failure warning. */
function enterGivenUp(sessionId: string, t: Tracker): void {
  t.phase = "given_up";
  armTimer(t, t.io.givenUpRetentionMs ?? GIVEN_UP_RETENTION_MS, () =>
    finish(sessionId),
  );
}

/** A receipt arrived for a tracker that had already given up — the warning
 *  was premature. Say so and withdraw it. */
function retractGiveUp(sessionId: string, t: Tracker, eventName: string): void {
  let retracted = 0;
  for (const id of t.failureNotificationIds) {
    try {
      if (t.io.retract?.(id)) retracted++;
    } catch (err) {
      console.warn(
        `[prompt-delivery] ${t.label} retract callback threw:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  console.log(
    `[prompt-delivery] ${t.label} ${eventName} arrived after give-up — the ` +
      `prompt was delivered after all${retracted > 0 ? "; earlier warning retracted" : ""}`,
  );
  finish(sessionId);
}

/**
 * Feed a hook event into the tracker. Called from the hooks route for every
 * event, after provider normalization. No-op for untracked sessions.
 */
export function notePromptHookEvent(
  sessionId: string,
  eventName: string,
  source?: string,
): void {
  const t = trackers.get(sessionId);
  if (!t) return;

  if (eventName === "SessionStart") {
    // Compact-triggered SessionStarts are mid-conversation, not a boot.
    if (source === "compact") return;
    if (t.phase === "given_up") {
      retractGiveUp(sessionId, t, eventName);
      return;
    }
    if (t.phase !== "awaiting_session_start") return;
    t.phase = "awaiting_prompt_submit";
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    // The submit window is only meaningful once dialogs are out of the way —
    // if they aren't yet, noteStartupSettled arms it.
    if (t.settled) {
      armTimer(t, t.io.promptSubmitTimeoutMs ?? PROMPT_SUBMIT_TIMEOUT_MS, () =>
        redeliver(sessionId),
      );
    }
    return;
  }

  if (eventName === "SessionEnd") {
    if (t.phase !== "awaiting_session_start" && t.phase !== "given_up") {
      console.log(
        `[prompt-delivery] ${t.label} session ended before prompt delivery was confirmed`,
      );
    }
    finish(sessionId);
    return;
  }

  if (DELIVERY_CONFIRMING_EVENTS.has(eventName)) {
    if (t.phase === "given_up") {
      retractGiveUp(sessionId, t, eventName);
      return;
    }
    if (t.enterTimer !== null) {
      // The original delivery confirmed in the gap between our paste and its
      // Enter — the pasted duplicate is sitting in the input box as a draft.
      // Clear it (Ctrl-U kills the input line; harmless if the TUI ignores
      // it) so a later stray keystroke can't double-submit.
      console.warn(
        `[prompt-delivery] ${t.label} ${eventName} arrived mid-re-delivery — ` +
          `abandoning the paste and clearing the input draft`,
      );
      t.io.write("\x15");
    } else if (t.phase === "awaiting_redelivery_confirm") {
      console.log(
        `[prompt-delivery] ${t.label} prompt re-delivery confirmed (${eventName})`,
      );
    }
    finish(sessionId);
  }
}

/** The fallback: bracketed paste + Enter, exactly once. */
function redeliver(sessionId: string): void {
  const t = trackers.get(sessionId);
  // Re-check at fire time — a confirming event finishes the tracker
  // synchronously, so a live tracker here means no submission was seen.
  if (!t || t.phase !== "awaiting_prompt_submit") return;

  const waitedMs = t.io.promptSubmitTimeoutMs ?? PROMPT_SUBMIT_TIMEOUT_MS;
  console.warn(
    `[prompt-delivery] ${t.label} SessionStart arrived but no UserPromptSubmit ` +
      `within ${waitedMs}ms of startup settling — starting prompt was likely dropped. ` +
      `Re-delivering via PTY paste (one retry only).`,
  );

  // Bracketed paste keeps multi-line prompts intact (a bare newline inside
  // the paste must not submit early); the Enter outside the markers submits.
  const pasted = t.io.write(`\x1b[200~${t.prompt}\x1b[201~`);
  if (!pasted) {
    console.warn(
      `[prompt-delivery] ${t.label} re-delivery aborted — PTY is gone`,
    );
    finish(sessionId);
    return;
  }
  // Notify only after the paste actually landed — a dashboard claim of
  // re-delivery must not precede (or survive) a failed write. Factual, so
  // never retracted.
  safeNotify(
    t,
    "Starting prompt was not submitted — autonomOS re-delivered it via the terminal.",
  );
  t.enterTimer = setTimeout(() => {
    t.enterTimer = null;
    if (!t.io.write("\r")) {
      console.warn(
        `[prompt-delivery] ${t.label} PTY died between paste and Enter — giving up`,
      );
      finish(sessionId);
    }
  }, t.io.redeliverEnterDelayMs ?? REDELIVER_ENTER_DELAY_MS);

  // Watch for the receipt one more time — purely for observability; there is
  // never a second re-delivery.
  t.phase = "awaiting_redelivery_confirm";
  armTimer(t, waitedMs, () => {
    const tr = trackers.get(sessionId);
    if (!tr || tr.phase !== "awaiting_redelivery_confirm") return;
    console.error(
      `[prompt-delivery] ${tr.label} re-delivery also produced no ` +
        `UserPromptSubmit — giving up. The agent needs a manual nudge.`,
    );
    const id = safeNotify(
      tr,
      "Prompt re-delivery failed — the agent may be stuck and needs a manual nudge.",
    );
    if (id) tr.failureNotificationIds.push(id);
    enterGivenUp(sessionId, tr);
  });
}

/** Stop tracking (PTY exited, agent killed/deleted). Safe on untracked ids. */
export function cancelPromptTracking(sessionId: string): void {
  finish(sessionId);
}

/** Stop all tracking (server shutdown / restart-all). */
export function cancelAllPromptTracking(): void {
  for (const id of Array.from(trackers.keys())) finish(id);
}

/** For testing — inspect the tracker phase. */
export function _getPhaseForTesting(sessionId: string): Phase | undefined {
  return trackers.get(sessionId)?.phase;
}

/** For testing — reset internal state. */
export function _resetForTesting(): void {
  cancelAllPromptTracking();
}
