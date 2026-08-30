/**
 * Hand-off delivery — injects a QUEUED message into a manual-queue agent's PTY
 * on a trigger, and dequeues it only when a UserPromptSubmit hook confirms it
 * was submitted (the receipt). The item leaves the queue on CONFIRMATION, never
 * on injection — an unconfirmed paste keeps the message safely queued.
 *
 * Mirrors promptDelivery's mechanics (bracketed-paste + a delayed Enter) but is
 * simpler: the agent is already running and long past its startup dialogs, so no
 * settle-gating is needed. ONE injection is in flight per agent at a time — the
 * hook payload carries no per-message id, so the next confirming event for that
 * session is taken as the receipt for the in-flight item (serialize, don't try
 * to match). A send-all drains the queue one item at a time, each gated on its
 * own receipt.
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
const ENTER_DELAY_MS = 150;

// If no confirming hook arrives within this window, release the in-flight lock
// WITHOUT dequeuing (the message stays queued) so a human can retry — a stuck or
// swallowed paste must not wedge the agent's queue forever.
const RECEIPT_TIMEOUT_MS = 90_000;

// Events that prove the injected text was submitted as a turn. Gemini maps its
// BeforeAgent → UserPromptSubmit (see gemini-cli provider), which fires when it
// starts processing the pasted message.
const CONFIRMING_EVENTS = new Set(["UserPromptSubmit"]);

export type InjectResult = { ok: true } | { ok: false; reason: string };

interface InFlight {
  itemId: string;
  drainAll: boolean;
  timer: ReturnType<typeof setTimeout>;
}

// agentId → the item awaiting a receipt. At most one per agent.
const inFlight = new Map<string, InFlight>();

function formatForInjection(from: string, message: string): string {
  return `[${from} → you (hand-delivered)]\n${message}`;
}

function emitPending(agentId: string): void {
  const rec = getAgent(agentId as UUID);
  if (!rec) return;
  emitAgentDelta({
    type: "agent.updated",
    id: rec.id,
    patch: { pendingHandoffCount: handoffQueueCount(agentId) },
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
    return {
      ok: false,
      reason: `PTY write failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  const timer = setTimeout(() => {
    // No receipt in time — release the lock; leave the item queued.
    inFlight.delete(agentId);
  }, RECEIPT_TIMEOUT_MS);
  timer.unref?.();
  inFlight.set(agentId, { itemId, drainAll: opts.drainAll ?? false, timer });

  const enterTimer = setTimeout(() => {
    try {
      pty.write("\r");
    } catch {
      // PTY vanished between the paste and the Enter — the receipt timeout
      // releases the lock and the item stays queued for a retry.
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
 * for an agent with an in-flight injection, the item is dequeued (the receipt)
 * and — for a send-all — the next item is injected.
 */
export function noteHandoffDelivery(agentId: string, eventName: string): void {
  const f = inFlight.get(agentId);
  if (!f || !CONFIRMING_EVENTS.has(eventName)) return;
  clearTimeout(f.timer);
  inFlight.delete(agentId);
  removeHandoffItem(agentId, f.itemId);
  emitPending(agentId);
  if (f.drainAll) {
    const next = peekNextHandoff(agentId);
    if (next) injectHandoffItem(agentId, next.id, { drainAll: true });
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
