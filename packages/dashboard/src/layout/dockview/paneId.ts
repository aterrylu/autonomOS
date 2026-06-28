import type { ActivePane } from "../../store";

/**
 * Pure dockview-panel-id ↔ ActivePane helpers (no React / dockview / xterm deps,
 * so they're unit-testable on their own). dockview panel ids ARE autonomOS pane
 * ids, and the id space is unambiguous.
 */

/** Panes that exist as a single global instance (the id IS the type). The
 *  `satisfies` check guarantees every entry is a valid ActivePane, so this stays
 *  in sync with the ActivePane union without casts. */
export const SINGLETON_PANES = {
  orgchart: { type: "orgchart", id: "orgchart" },
  templates: { type: "templates", id: "templates" },
  schedules: { type: "schedules", id: "schedules" },
  "create-agent": { type: "create-agent", id: "create-agent" },
} as const satisfies Record<string, ActivePane>;

/** Singleton pane ids, derived from SINGLETON_PANES (single source of truth). */
export const SINGLETON_TYPES = new Set<string>(Object.keys(SINGLETON_PANES));

/**
 * Reconstruct an ActivePane descriptor from a dockview panel id: singleton views
 * use a fixed id == their type, preview panes are tracked in the store
 * (`previewIds`), everything else is a session.
 */
export function paneFromId(id: string, previewIds: Set<string>): ActivePane {
  if (id in SINGLETON_PANES)
    return SINGLETON_PANES[id as keyof typeof SINGLETON_PANES];
  if (previewIds.has(id)) return { type: "preview", id };
  return { type: "session", id };
}
