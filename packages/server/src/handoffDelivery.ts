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

import type { HandoffQueueItem, UUID } from "@autonomos/core";
import { getAttachment } from "./agents/runtime.js";
import { getAgent } from "./agents/store.js";
import { emitAgentDelta } from "./events/agents.js";
import {
  handoffQueueCount,
  listHandoffQueue,
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
  /** The item id(s) this injection will dequeue on its receipt: one for a
   *  single Send, ALL of them for send-all (one batched injection, one receipt,
   *  all-or-nothing — Terry wants send-all delivered ONCE, not drained). */
  itemIds: string[];
  /** Short label for logs (e.g. "item ab12" or "send-all (3)"). */
  label: string;
  /** True only once the submitting Enter has been written — see the header. */
  armed: boolean;
  timer: ReturnType<typeof setTimeout>;
  /** The pending Enter write. Tracked on the entry so releasing the lock
   *  cancels it — otherwise an orphaned `\r` from a released injection lands on
   *  the NEXT injection's paste, submitting it early + unarmed (nox review). */
  enterTimer?: ReturnType<typeof setTimeout>;
}

// agentId → the item awaiting a receipt. At most one per agent.
const inFlight = new Map<string, InFlight>();

/**
 * Sender-kind-aware trailing guidance, dispatched on the from_uri SCHEME
 * (ADR-092 sender semantics). A hand-delivered paste lacks the `<channel>`
 * framing a live inbound carries, so this line is what teaches the recipient how
 * to treat it — and that DIFFERS by sender kind: an agent can be replied to, a
 * scheduled prompt cannot (Terry's catch — telling a schedule-fired prompt to
 * "reply to another agent" is wrong: it's not an agent and has no reply path).
 * Table-driven so a new scheme falls back to the safe informational wording, not
 * the agent reply instruction.
 */
function deliveryHint(fromUri: string): string {
  const sep = fromUri.indexOf("://");
  const scheme = sep === -1 ? "" : fromUri.slice(0, sep);
  const name = sep === -1 ? fromUri : fromUri.slice(sep + 3);
  switch (scheme) {
    case "agent":
      return `hand-delivered via autonomOS — reply with the autonomos MCP send tool to ${fromUri}`;
    case "schedule":
      return `scheduled prompt from the autonomOS schedule '${name}' — cannot be replied to, just do the task`;
    default:
      return "hand-delivered via autonomOS — informational, no reply";
  }
}

function formatForInjection(item: HandoffQueueItem): string {
  // Strip the bracketed-paste terminator + bare CR from the agent-controlled
  // fields so a crafted message can't close paste-mode early and inject raw
  // keystrokes (control sequences, auto-submitting newlines) into the pane the
  // human is watching. This content arrives over the gateway from a DIFFERENT
  // agent — a wider door than promptDelivery's own argv (nox review).
  const clean = (s: string) => s.replace(/\x1b\[201~/g, "").replace(/\r/g, "");
  const from = clean(item.from);
  const uri = clean(item.fromUri ?? `agent://${item.from}`);
  const body = clean(item.message);
  // COMPACT single-line envelope (Terry: the multi-line guidance wrapped ugly):
  // the standard inbound HEADER (same `[from → you via uri]` as formatInbound)
  // and the sender-kind-aware guidance on ONE line — guidance in parens right
  // after the brackets — then the body (ADR-094).
  return `[${from} → you via ${uri}](${deliveryHint(uri)})\n${body}`;
}

/** Release the in-flight lock (clearing BOTH its timers) without dequeuing. */
function clearInFlight(agentId: string): void {
  const f = inFlight.get(agentId);
  if (!f) return;
  clearTimeout(f.timer);
  if (f.enterTimer) clearTimeout(f.enterTimer);
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
 * Inject a composed paste (one or more items' envelopes) into the agent's PTY as
 * ONE bracketed paste + a delayed Enter. Returns ok:false (touching NOTHING) if
 * an injection is already awaiting confirmation or the agent has no live PTY. The
 * items are NOT removed here — they leave the queue only when
 * {@link noteHandoffDelivery} sees the receipt (which then dequeues ALL of
 * `itemIds` — a batch is all-or-nothing).
 */
function injectPaste(
  agentId: string,
  itemIds: string[],
  paste: string,
  label: string,
): InjectResult {
  if (inFlight.has(agentId)) {
    return {
      ok: false,
      reason: "An injection is already awaiting confirmation for this agent.",
    };
  }
  const pty = getAttachment(agentId as UUID)?.pty;
  if (!pty)
    return { ok: false, reason: "Agent has no live PTY to deliver into." };

  try {
    pty.write(`\x1b[200~${paste}\x1b[201~`);
  } catch (err) {
    const reason = `PTY write failed: ${err instanceof Error ? err.message : err}`;
    console.error(
      `[handoff] paste write to ${agentId.slice(0, 8)} failed (${label}) — ${reason}`,
    );
    return { ok: false, reason };
  }

  const entry: InFlight = {
    itemIds,
    label,
    armed: false,
    timer: setTimeout(() => {
      // No receipt in time — release the lock; the message(s) stay queued (a
      // batch is all-or-nothing, so none are lost). A stuck/swallowed paste is a
      // real operational event, so say so.
      inFlight.delete(agentId);
      console.warn(
        `[handoff] no delivery receipt for ${label} to ${agentId.slice(0, 8)} within ${RECEIPT_TIMEOUT_MS}ms — lock released, ${itemIds.length} message(s) left queued`,
      );
    }, RECEIPT_TIMEOUT_MS),
  };
  entry.timer.unref?.();
  inFlight.set(agentId, entry);

  entry.enterTimer = setTimeout(() => {
    // Bail if THIS injection is no longer the one in flight — the lock was
    // released (SessionEnd, a receipt) and possibly re-taken. clearInFlight also
    // cancels this timer, so this is belt-and-suspenders against a callback
    // already queued on the event loop (nox review).
    if (inFlight.get(agentId) !== entry) return;
    try {
      pty.write("\r");
      // Arm the receipt ONLY now — the injected text is submitted at this point,
      // so its UserPromptSubmit is the next confirming event we should accept.
      entry.armed = true;
    } catch {
      // PTY vanished between the paste and the Enter. Leave the lock unarmed so
      // no stray event is mistaken for a receipt; the timeout releases it.
      console.warn(
        `[handoff] Enter write to ${agentId.slice(0, 8)} failed (${label}) — paste left unsubmitted; receipt not armed`,
      );
    }
  }, ENTER_DELAY_MS);
  entry.enterTimer.unref?.();

  return { ok: true };
}

/**
 * Deliver ONE queued item. The item leaves the queue only on its receipt.
 */
export function injectHandoffItem(
  agentId: string,
  itemId: string,
): InjectResult {
  const item = listHandoffQueue(agentId).find((i) => i.id === itemId);
  if (!item) return { ok: false, reason: "No such queued item." };
  return injectPaste(
    agentId,
    [itemId],
    formatForInjection(item),
    `item ${itemId.slice(0, 8)}`,
  );
}

/**
 * Deliver the WHOLE queue as ONE injection — every message's envelope
 * concatenated into a single paste with one Enter, and a single receipt dequeues
 * the whole batch (Terry: send-all should be delivered once, all-or-nothing, not
 * drained one-at-a-time behind each other).
 */
export function injectAllHandoffs(agentId: string): InjectResult {
  const items = listHandoffQueue(agentId);
  if (items.length === 0) return { ok: false, reason: "The queue is empty." };
  const paste = items.map(formatForInjection).join("\n\n");
  return injectPaste(
    agentId,
    items.map((i) => i.id),
    paste,
    `send-all (${items.length})`,
  );
}

/**
 * Fed from routes/hooks.ts on every normalized hook event. On a confirming event
 * for an agent whose in-flight injection is ARMED, the item is dequeued (the
 * receipt), dequeuing EVERY item that injection delivered (all of a send-all
 * batch at once). A session-end event releases the lock without dequeuing (the
 * agent is gone).
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
  // Everything below touches the filesystem (readQueue/writeQueue). A throw
  // here (ENOSPC/EACCES on the rename, a config dir gone read-only, a file that
  // went corrupt between enqueue and receipt) must NOT take down the hook-ingest
  // POST — that would skip deriveStatus, compaction handling, notifications, and
  // the agent.updated delta for this event. Best-effort, mirroring flushActivity
  // in agents/store.ts. The lock is already released (above), so the next hook
  // no-ops; the item reverts to "still queued" (the operator re-delivers) rather
  // than being silently lost (nox review).
  try {
    // Dequeue EVERY item this injection delivered — one for a single Send, all
    // of them for a send-all batch (the batch confirmed as a unit).
    for (const itemId of f.itemIds) removeHandoffItem(agentId, itemId);
    emitPendingHandoffCount(agentId);
    console.log(
      `[handoff] delivered ${f.label} (${f.itemIds.length} message(s)) to ${agentId.slice(0, 8)} — confirmed by ${eventName}`,
    );
  } catch (err) {
    console.error(
      `[handoff] dequeue after receipt for ${agentId.slice(0, 8)} failed — item(s) may remain queued:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** True if an injection into this agent is awaiting its receipt. */
export function hasInFlightHandoff(agentId: string): boolean {
  return inFlight.has(agentId);
}

/** Test hook — clear all in-flight state + BOTH timers (the enter timer too, or
 *  an orphaned `\r` from one case writes into the next case's captured writes). */
export function _resetHandoffDeliveryForTesting(): void {
  for (const f of inFlight.values()) {
    clearTimeout(f.timer);
    if (f.enterTimer) clearTimeout(f.enterTimer);
  }
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
