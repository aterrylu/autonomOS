/**
 * Enrich an agent with its derived `pendingHandoffCount` for the dashboard
 * badge. Used at EVERY serialization boundary the dashboard reads agents from —
 * the REST `GET /api/agents` list AND the `/ws/agents` reconcile snapshot — so a
 * fresh page load with a pre-existing queue shows the badge, not only after the
 * next live delta. (Live enqueue/dequeue already emit an `agent.updated` patch;
 * this covers the INITIAL snapshot those deltas predate.)
 *
 * A corrupt queue file must NEVER take down an always-on agent listing, so an
 * unreadable queue degrades that one agent to "no badge" with a loud log; the
 * file is left on disk for recovery, never silently deleted.
 */

import type { Agent } from "@autonomos/core";
import { handoffQueueCount } from "../handoffQueue.js";
import { getProvider } from "../providers/index.js";

export function withPendingHandoffCount(a: Agent): Agent {
  if (
    getProvider(a.provider).capabilities.messaging.inboundMethod !==
    "manual-queue"
  ) {
    return a;
  }
  let count: number;
  try {
    count = handoffQueueCount(a.id);
  } catch (err) {
    console.error(
      `[agents] hand-off queue for ${a.id.slice(0, 8)} is unreadable — badge omitted:`,
      err instanceof Error ? err.message : err,
    );
    return a;
  }
  return count > 0 ? { ...a, pendingHandoffCount: count } : a;
}
