/**
 * Hand-off delivery — injects a QUEUED message into a manual-queue agent's PTY
 * on a trigger, and dequeues it only when a UserPromptSubmit hook confirms it
 * was submitted (the receipt). The item leaves the queue on CONFIRMATION, never
 * on injection — an unconfirmed paste keeps the message safely queued.
 *
 * Mirrors promptDelivery's mechanics (bracketed-paste + a delayed Enter) but is
 * simpler: the agent is already running and long past its startup dialogs, so no
 * settle-gating is needed. ONE injection is in flight per agent at a time.
 *
 * RECEIPT CORRELATION (and its known limit). The hook payload carries no
 * per-message id, so we cannot match a UserPromptSubmit to the exact injected
 * text; the next confirming event is taken as the receipt. Two guards keep that
 * from silently dequeuing an UNDELIVERED message:
 *   1. The receipt is ARMED only AFTER the submitting Enter is written — so a
 *      UserPromptSubmit that fires BEFORE the Enter (a prior turn's late hook, or
 *      a human typing in the pane in the paste→Enter window) can't be mistaken
 *      for the receipt of a message that hasn't been submitted yet.
 *   2. Every dequeue is LOGGED (item id, sender, the event taken as its receipt)
 *      so a mis-correlation is auditable rather than invisible.
 * A residual remains: a stray UserPromptSubmit in the brief window AFTER the
 * Enter but BEFORE the injected text's own submit hook would still be taken as
 * the receipt. Narrow (single-fire Gemini hooks), logged, and the file stays on
 * disk — full text-correlation is a follow-up gated on the hook payload's shape.
 *
 * The delivery TRIGGER is a caller decision, not baked in (Terry's extensibility
 * directive): a human click today, an auto-send mode or a user-input textbox
 * tomorrow all call injectHandoffItem / injectAllHandoffs.
 */

import type { UUID } from "@autonomos/core";
import { getAttachment } from "./agents/runtime.js";
import { getAgent } from "./agents/store.js";
import { emitAgentDelta } from "./events/agents.js";
import {
  handoffQueueCount,
  listHandoffQueue,
  peekNextHandoff,
  removeHandoffItem,
} from "./handoffQueue.js";

// The submitting Enter is sent slightly after the paste so the TUI has finished
// processing the bracketed block first (mirrors promptDelivery's enter delay).
// If no confirming hook arrives within RECEIPT_TIMEOUT_MS, release the in-flight
// lock WITHOUT dequeuing (the message stays queued) so a human can retry — a
// stuck or swallowed paste must not wedge the agent's queue forever. Both are
// mutable so tests can shrink them (see _setHandoffTimingsForTesting).
let ENTER_DELAY_MS = 150;
let RECEIPT_TIMEOUT_MS = 90_000;

// Events that prove the injected text was submitted as a turn. Gemini maps its
// BeforeAgent → UserPromptSubmit (see gemini-cli provider), which fires when it
// starts processing the pasted message.
const CONFIRMING_EVENTS = new Set(["UserPromptSubmit"]);

// Events that mean the agent is gone — release any in-flight lock (WITHOUT
// dequeuing) so a resume within the receipt window isn't refused against a dead
// PTY. The message stays queued for delivery after the resume.
const RELEASE_EVENTS = new Set(["SessionEnd"]);

export type InjectResult = { ok: true } | { ok: false; reason: string };

interface InFlight {
  itemId: string;
  from: string;
  drainAll: boolean;
  /** True only once the submitting Enter has been written — see the header. */
  armed: boolean;
  timer: ReturnType<typeof setTimeout>;
}

// agentId → the item awaiting a receipt. At most one per agent.
const inFlight = new Map<string, InFlight>();

function formatForInjection(from: string, message: string): string {
  return `[${from} → you (hand-delivered)]\n${message}`;
}

/** Release the in-flight lock (clearing its timer) without dequeuing. */
function clearInFlight(agentId: string): void {
  const f = inFlight.get(agentId);
  if (!f) return;
  clearTimeout(f.timer);
  inFlight.delete(agentId);
}

/**
 * Push the current pending hand-off count to live dashboards as an
 * `agent.updated` patch. Shared by every enqueue/dequeue/discard path. Reuses
 * the record's CURRENT version — a queue change is derived state, not a record
 * mutation, so it must NOT bump the optimistic-concurrency version (mirrors how
 * lastActivityAt is emitted). A missing record is a no-op. Pass an explicit
 * `count` to avoid re-reading the store when the caller already has it.
 */
export function emitPendingHandoffCount(
  agentId: string,
  count = handoffQueueCount(agentId),
): void {
  const rec = getAgent(agentId as UUID);
  if (!rec) return;
  emitAgentDelta({
    type: "agent.updated",
    id: rec.id,
    patch: { pendingHandoffCount: count },
    version: rec.version,
  });
}

/**
 * Inject one queued item into the agent's PTY. Returns ok:false (without
 * touching the queue) if another injection is already awaiting confirmation, the
 * item is gone, or the agent has no live PTY. The item is NOT removed here — it
 * leaves the queue only when {@link noteHandoffDelivery} sees the receipt.
 */
export function injectHandoffItem(
  agentId: string,
  itemId: string,
  opts: { drainAll?: boolean } = {},
): InjectResult {
  if (inFlight.has(agentId)) {
    return {
      ok: false,
      reason: "An injection is already awaiting confirmation for this agent.",
    };
  }
  const item = listHandoffQueue(agentId).find((i) => i.id === itemId);
  if (!item) return { ok: false, reason: "No such queued item." };

  const pty = getAttachment(agentId as UUID)?.pty;
  if (!pty)
    return { ok: false, reason: "Agent has no live PTY to deliver into." };

  try {
    pty.write(
      `\x1b[200~${formatForInjection(item.from, item.message)}\x1b[201~`,
    );
  } catch (err) {
    const reason = `PTY write failed: ${err instanceof Error ? err.message : err}`;
    console.error(
      `[handoff] paste write to ${agentId.slice(0, 8)} failed for item ${itemId.slice(0, 8)} — ${reason}`,
    );
    return { ok: false, reason };
  }

  const entry: InFlight = {
    itemId,
    from: item.from,
    drainAll: opts.drainAll ?? false,
    armed: false,
    timer: setTimeout(() => {
      // No receipt in time — release the lock (leave the item queued) and say
      // so: a stuck/swallowed paste is a real operational event, and for a
      // send-all this aborts the drain, so the operator needs a signal beyond a
      // badge that simply stops moving.
      inFlight.delete(agentId);
      console.warn(
        `[handoff] no delivery receipt for item ${itemId.slice(0, 8)} to ${agentId.slice(0, 8)} within ${RECEIPT_TIMEOUT_MS}ms — lock released, message left queued${
          entry.drainAll ? " (send-all drain aborted)" : ""
        }`,
      );
    }, RECEIPT_TIMEOUT_MS),
  };
  entry.timer.unref?.();
  inFlight.set(agentId, entry);

  const enterTimer = setTimeout(() => {
    try {
      pty.write("\r");
      // Arm the receipt ONLY now — the injected text is submitted at this point,
      // so its UserPromptSubmit is the next confirming event we should accept.
      const cur = inFlight.get(agentId);
      if (cur && cur.itemId === itemId) cur.armed = true;
    } catch {
      // PTY vanished between the paste and the Enter. The message was never
      // submitted; leave the lock unarmed so no stray event is mistaken for a
      // receipt, and let the timeout release it. Log — a half-injected paste
      // now sits in the TUI buffer and a retry would concatenate onto it.
      console.warn(
        `[handoff] Enter write to ${agentId.slice(0, 8)} failed for item ${itemId.slice(0, 8)} — paste left unsubmitted; receipt not armed`,
      );
    }
  }, ENTER_DELAY_MS);
  enterTimer.unref?.();

  return { ok: true };
}

/** Begin delivering the whole queue, one item at a time (send-all). Each item
 *  is gated on its own receipt before the next is injected. */
export function injectAllHandoffs(agentId: string): InjectResult {
  const next = peekNextHandoff(agentId);
  if (!next) return { ok: false, reason: "The queue is empty." };
  return injectHandoffItem(agentId, next.id, { drainAll: true });
}

/**
 * Fed from routes/hooks.ts on every normalized hook event. On a confirming event
 * for an agent whose in-flight injection is ARMED, the item is dequeued (the
 * receipt) and — for a send-all — the next item is injected. A session-end event
 * releases the lock without dequeuing (the agent is gone).
 */
export function noteHandoffDelivery(agentId: string, eventName: string): void {
  const f = inFlight.get(agentId);
  if (!f) return;

  if (RELEASE_EVENTS.has(eventName)) {
    clearInFlight(agentId);
    return;
  }

  // Not a receipt yet: a non-confirming event, or a confirming one that arrived
  // before the Enter armed it (see the header — this is the pre-Enter guard).
  if (!CONFIRMING_EVENTS.has(eventName) || !f.armed) return;

  clearInFlight(agentId);
  removeHandoffItem(agentId, f.itemId);
  emitPendingHandoffCount(agentId);
  console.log(
    `[handoff] delivered item ${f.itemId.slice(0, 8)} (from ${f.from}) to ${agentId.slice(0, 8)} — confirmed by ${eventName}`,
  );

  if (f.drainAll) {
    const next = peekNextHandoff(agentId);
    if (next) {
      const r = injectHandoffItem(agentId, next.id, { drainAll: true });
      if (!r.ok) {
        // The drain can't continue (PTY gone, etc.). Say so — remaining items
        // stay queued but the operator's "send all" quietly stopped partway.
        console.warn(
          `[handoff] send-all drain to ${agentId.slice(0, 8)} stopped: ${r.reason} (${handoffQueueCount(agentId)} still queued)`,
        );
      }
    }
  }
}

/** True if an injection into this agent is awaiting its receipt. */
export function hasInFlightHandoff(agentId: string): boolean {
  return inFlight.has(agentId);
}

/** Test hook — clear all in-flight state + timers. */
export function _resetHandoffDeliveryForTesting(): void {
  for (const f of inFlight.values()) clearTimeout(f.timer);
  inFlight.clear();
}

/** Test hook — shrink the Enter delay / receipt timeout so tests don't wait
 *  real wall-clock. Omitting a field restores its production default. */
export function _setHandoffTimingsForTesting(opts?: {
  enterDelayMs?: number;
  receiptTimeoutMs?: number;
}): void {
  ENTER_DELAY_MS = opts?.enterDelayMs ?? 150;
  RECEIPT_TIMEOUT_MS = opts?.receiptTimeoutMs ?? 90_000;
}
