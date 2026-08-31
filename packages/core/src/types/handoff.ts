/**
 * Hand-Off Queue — types shared between server (the persisted store + gateway)
 * and dashboard (the pending-count badge + delivery pane).
 *
 * An inbound-less agent (a provider whose `messaging.inboundMethod` is
 * "manual-queue", e.g. Gemini's interactive CLI) cannot receive a live message.
 * Instead of failing the send, the gateway QUEUES it for human hand-delivery:
 * a person opens the agent's pane and triggers injection into the PTY, confirmed
 * by a UserPromptSubmit hook.
 *
 * Extensibility (Terry's directive): the delivery TRIGGER is deliberately NOT
 * part of the entry. An item carries only what's needed to be delivered by ANY
 * trigger — a human click today, or a future auto-send mode / a dedicated
 * user-input textbox whose messages enter this same queue. Do not add a
 * "deliveredBy"/"queuedByHuman" field to the entry.
 */

/** A single message queued for human hand-delivery to an inbound-less agent. */
export interface HandoffQueueItem {
  /** Server-generated unique id — addresses send-one / discard-one. */
  id: string;
  /**
   * The sender's display name, shown in the pane so the operator knows who the
   * message is from. Provenance only — never a trigger.
   */
  from: string;
  /**
   * The sender's reply address (`agent://Name`, or `schedule://name` for a
   * scheduled prompt). Used to render the standard inbound ENVELOPE at injection
   * (`[from → you via fromUri] …`) so a hand-delivered message reads as
   * inter-agent mail, not user-pasted text, and the recipient can reply via the
   * MCP send tool. Optional for forward-compat with pre-envelope queue files.
   */
  fromUri?: string;
  /**
   * The message BODY (no envelope). The pane preview shows this; the envelope is
   * added only in what's injected into the PTY.
   */
  message: string;
  /** When it was enqueued (epoch ms). */
  enqueuedAt: number;
}

/**
 * Max undelivered items per agent. A send past this is REJECTED as a real
 * failure (distinct from the under-cap accept-and-queue success), so an
 * unattended agent's queue can't grow without bound. Terry's Q5.
 */
export const HANDOFF_QUEUE_CAP = 10;

/** Outcome of enqueueing a hand-off message. */
export type HandoffEnqueueResult =
  | { ok: true; item: HandoffQueueItem; count: number }
  | { ok: false; reason: "full"; count: number };
