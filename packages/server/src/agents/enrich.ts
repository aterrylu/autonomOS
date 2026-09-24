/**
 * Derived, non-persisted fields the dashboard needs on a WHOLE agent record.
 * Applied at every boundary that ships one — the REST `GET /api/agents`
 * list/item, the `/ws/agents` reconcile snapshot, and the `agent.created` /
 * `agent.attached` deltas (installed verbatim client-side, so an un-enriched one
 * would blank the derived fields). One function so a new derived field can't be
 * wired into three boundaries and forgotten at the fourth.
 */

import type { Agent } from "@autonomos/core";
import { cachedGitBranch } from "./gitBranch.js";
import { withPendingHandoffCount } from "./handoffEnrich.js";

export function enrichAgent(a: Agent): Agent {
  const enriched = withPendingHandoffCount(a);
  const gitBranch = cachedGitBranch(a.workingDirectory);
  return gitBranch ? { ...enriched, gitBranch } : enriched;
}
