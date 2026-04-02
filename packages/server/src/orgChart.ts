/**
 * Org chart builder — derives hierarchy from persisted session metadata.
 *
 * Used by both the HTTP MCP server and REST API routes.
 */

import type { PersistedSession } from "./persisted.js";
import { getPersistedSessions } from "./persisted.js";

export interface OrgNode {
  name: string;
  template?: string;
  project?: string;
  children: OrgNode[];
}

function toNode(s: PersistedSession): OrgNode {
  return {
    name: s.name,
    template: s.template,
    project: s.project,
    children: [],
  };
}

/** Build a tree from persisted sessions using the manager field. */
export function buildOrgChart(): OrgNode[] {
  const sessions = getPersistedSessions();
  const nodeMap = new Map<string, OrgNode>();

  for (const s of sessions) {
    nodeMap.set(s.name.toLowerCase(), toNode(s));
  }

  const roots: OrgNode[] = [];
  for (const s of sessions) {
    const node = nodeMap.get(s.name.toLowerCase())!;
    const parentKey = s.manager?.toLowerCase();
    const parent = parentKey ? nodeMap.get(parentKey) : undefined;

    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}
