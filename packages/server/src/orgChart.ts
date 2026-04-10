/**
 * Org chart builder — derives hierarchy from persisted session metadata.
 *
 * Used by both the HTTP MCP server and REST API routes.
 */

import type { PersistedSession } from "./persisted.js";
import { getPersistedSessions } from "./persisted.js";

export interface OrgNode {
  /** Unique identifier — each persisted session has its own node. */
  claudeSessionId: string;
  name: string;
  template?: string;
  project?: string;
  /** Lifecycle — "running" or "exited". Derived from persisted session. */
  status: "running" | "exited";
  children: OrgNode[];
}

function toNode(s: PersistedSession): OrgNode {
  return {
    claudeSessionId: s.claudeSessionId,
    name: s.name,
    template: s.template,
    project: s.project,
    status: s.status === "exited" ? "exited" : "running",
    children: [],
  };
}

/**
 * Choose the canonical session for a given name when multiple sessions share it.
 * Called when two or more persisted sessions collide on name (e.g. agent killed
 * and respawned with the same name).
 *
 * Contract: given a non-empty list of sessions that share a name, return the
 * single session that should represent that name in the tree. The remaining
 * sessions in the group are dropped from the chart entirely.
 *
 * Trade-offs to consider:
 *  - Running sessions are more "alive" — agents referring to this name via
 *    `manager` probably mean the running one.
 *  - Ties (e.g. all running, or all exited) should be broken by recency
 *    (`persistedAt` — newer wins) since the newer one is what the user most
 *    recently intended.
 *  - The dropped sessions will NOT appear anywhere in the org chart, even as
 *    orphans — they'd collide on name again. That's intentional for Option A.
 */
function chooseCanonical(sameName: PersistedSession[]): PersistedSession {
  // Fast path + guard: callers never pass an empty array, but explicit
  // handling prevents a future refactor from crashing /api/org silently.
  if (sameName.length <= 1) return sameName[0];
  const running = sameName.filter((s) => s.status !== "exited");
  const pool = running.length > 0 ? running : sameName;
  // Newest persistedAt wins — most recently intended instance of this name.
  let best = pool[0];
  for (const s of pool) {
    if (s.persistedAt > best.persistedAt) best = s;
  }
  return best;
}

/**
 * Build a tree from persisted sessions using the manager field.
 *
 * TODO(follow-up): the sidebar has a "hide exited agents" toggle; the org
 * chart does not, so its view drifts from the sidebar. Adding one here is
 * non-trivial because hiding an exited parent could orphan its running
 * children — the hide logic has to either promote orphans to roots or
 * walk up to the nearest non-hidden ancestor. Out of scope for this PR.
 */
export function buildOrgChart(): OrgNode[] {
  const sessions = getPersistedSessions();

  // Group sessions by lowercased name — collisions mean the user killed and
  // respawned an agent with the same name.
  const byName = new Map<string, PersistedSession[]>();
  for (const s of sessions) {
    const key = s.name.toLowerCase();
    const bucket = byName.get(key);
    if (bucket) bucket.push(s);
    else byName.set(key, [s]);
  }

  // For each name, pick the canonical session and build its node. Keep both
  // the canonical session and the node together so we have the manager field
  // ready when wiring up the tree.
  const nodeByName = new Map<string, OrgNode>();
  const canonicalNodes: { src: PersistedSession; node: OrgNode }[] = [];
  for (const [nameKey, bucket] of byName) {
    const src = chooseCanonical(bucket);
    const node = toNode(src);
    nodeByName.set(nameKey, node);
    canonicalNodes.push({ src, node });
  }

  // Wire up the tree. Parent lookup is by manager name (the API takes names,
  // not IDs) — but each child is a uniquely-keyed node, so the
  // same-object-pushed-twice bug from the old implementation is gone.
  const roots: OrgNode[] = [];
  for (const { src, node } of canonicalNodes) {
    const parentKey = src.manager?.toLowerCase();
    const parent = parentKey ? nodeByName.get(parentKey) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
