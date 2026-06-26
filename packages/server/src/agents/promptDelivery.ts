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
 *   spawn(prompt) → SessionStart → UserPromptSubmit  ✓ delivered, done
 *
 * If SessionStart arrives but UserPromptSubmit never follows, the prompt is
 * re-delivered ONCE via PTY bracketed paste + Enter. Any sign of activity
 * (tool use, Stop, etc.) counts as proof the prompt ran and cancels the
 * fallback — double-submission is worse than a manual nudge.
 *
 * Leaf module by design: runtime.ts injects the PTY writer, routes/hooks.ts
 * feeds events in. No imports from either, so no cycles.
 */

/** No SessionStart within this window of spawn → warn (broken boot), give up. */
export const SESSION_START_TIMEOUT_MS = 15_000;
/**
 * No UserPromptSubmit within this window of SessionStart → re-deliver.
 * Generous on purpose: the signal is prompt SUBMISSION (UserPromptSubmit
 * fires when the prompt enters the conversation), not model latency.
 */
export const PROMPT_SUBMIT_TIMEOUT_MS = 20_000;
/** Gap between writing the bracketed paste and the submitting Enter. */
const REDELIVER_ENTER_DELAY_MS = 150;

export interface PromptDeliveryIO {
  /** Write raw data to the agent's PTY. Return false if the PTY is gone. */
  write(data: string): boolean;
  /** Surface an operator-visible note (e.g. dashboard notification). */
  notify?(message: string): void;
  /** Test overrides for the timing constants. */
  sessionStartTimeoutMs?: number;
  promptSubmitTimeoutMs?: number;
  redeliverEnterDelayMs?: number;
}

type Phase =
  | "awaiting_session_start"
  | "awaiting_prompt_submit"
  | "awaiting_redelivery_confirm"
  | "done";

interface Tracker {
  label: string;
  prompt: string;
  io: PromptDeliveryIO;
  phase: Phase;
  timer: NodeJS.Timeout | null;
  enterTimer: NodeJS.Timeout | null;
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
function safeNotify(t: Tracker, message: string): void {
  try {
    t.io.notify?.(message);
  } catch (err) {
    console.warn(
      `[prompt-delivery] ${t.label} notify callback threw:`,
      err instanceof Error ? err.message : err,
    );
  }
}

function finish(sessionId: string): void {
  const t = trackers.get(sessionId);
  if (!t) return;
  if (t.timer) clearTimeout(t.timer);
  if (t.enterTimer) clearTimeout(t.enterTimer);
  t.phase = "done";
  trackers.delete(sessionId);
}

/**
 * Begin tracking delivery for a session spawned with a starting prompt.
 * Call immediately after the PTY spawn. Idempotency: re-tracking the same
 * session replaces the previous tracker.
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
    timer: null,
    enterTimer: null,
  };
  trackers.set(sessionId, tracker);

  tracker.timer = setTimeout(() => {
    // Broken boot: the hook relay never reported SessionStart. Don't kill the
    // agent and don't paste into a process that may not even be a TUI yet —
    // just make the failure visible.
    console.warn(
      `[prompt-delivery] ${label} no SessionStart within ` +
        `${io.sessionStartTimeoutMs ?? SESSION_START_TIMEOUT_MS}ms of spawn — ` +
        `cannot confirm prompt delivery; skipping fallback (agent may have failed to boot)`,
    );
    safeNotify(
      tracker,
      "Agent never reported SessionStart — it may be stuck on a startup dialog. Open its terminal and check.",
    );
    finish(sessionId);
  }, io.sessionStartTimeoutMs ?? SESSION_START_TIMEOUT_MS);
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
    if (t.phase !== "awaiting_session_start") return;
    if (t.timer) clearTimeout(t.timer);
    t.phase = "awaiting_prompt_submit";
    t.timer = setTimeout(
      () => redeliver(sessionId),
      t.io.promptSubmitTimeoutMs ?? PROMPT_SUBMIT_TIMEOUT_MS,
    );
    return;
  }

  if (eventName === "SessionEnd") {
    if (t.phase !== "awaiting_session_start") {
      console.log(
        `[prompt-delivery] ${t.label} session ended before prompt delivery was confirmed`,
      );
    }
    finish(sessionId);
    return;
  }

  if (DELIVERY_CONFIRMING_EVENTS.has(eventName)) {
    if (t.enterTimer !== null) {
      // The original delivery confirmed in the 150ms gap between our paste
      // and its Enter — the pasted duplicate is sitting in the input box as a
      // draft. Clear it (Ctrl-U kills the input line; harmless if the TUI
      // ignores it) so a later stray keystroke can't double-submit.
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
      `within ${waitedMs}ms — starting prompt was likely dropped. ` +
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
  // re-delivery must not precede (or survive) a failed write.
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
  t.timer = setTimeout(() => {
    console.error(
      `[prompt-delivery] ${t.label} re-delivery also produced no ` +
        `UserPromptSubmit — giving up. The agent needs a manual nudge.`,
    );
    safeNotify(
      t,
      "Prompt re-delivery failed — the agent may be stuck and needs a manual nudge.",
    );
    finish(sessionId);
  }, waitedMs);
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
