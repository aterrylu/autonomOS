/**
 * Enrich an agent with its derived `pendingHandoffCount` for the dashboard
 * badge. Applied at every boundary that ships a WHOLE agent record the dashboard
 * installs verbatim — the REST `GET /api/agents` list, the `/ws/agents`
 * reconcile snapshot, AND the `agent.attached`/`agent.created` deltas (applied
 * wholesale via `agents.set`, so an un-enriched one would blank the badge). A
 * fresh page load, or a reattach, with a pre-existing queue thus shows the badge
 * immediately. (Live enqueue/dequeue emit a narrow `agent.updated` PATCH that
 * carries the count directly and needs no enrichment.)
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
