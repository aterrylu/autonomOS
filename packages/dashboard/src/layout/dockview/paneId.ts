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
 * use a fixed id == their type, everything else is a session.
 */
export function paneFromId(id: string): ActivePane {
  if (id in SINGLETON_PANES)
    return SINGLETON_PANES[id as keyof typeof SINGLETON_PANES];
  return { type: "session", id };
}

/**
 * The ActivePane to write back when a dockview panel becomes active, or `null`
 * when the panel must NOT be written back.
 *
 * `paneFromId` classifies every non-singleton id as a session. On its own that
 * would launder a panel restored from an older build (one whose `params.pane`
 * names a since-removed type) into `{type:"session", id}` — a value that then
 * *passes* `isValidActivePane` on the next reload, defeating that guard and
 * mounting a terminal for a session id that never existed (a perpetual
 * WebSocket reconnect loop). So when a panel carries its own descriptor, trust
 * it: an invalid descriptor means the panel is retired, and the writeback is
 * skipped rather than promoted. Panels with no descriptor fall back to
 * id-classification, which is what live sessions and singletons rely on.
 */
export function paneFromPanel(
  id: string,
  declaredPane: unknown,
): ActivePane | null {
  if (declaredPane !== undefined && !isValidActivePane(declaredPane))
    return null;
  return paneFromId(id);
}

/**
 * Validate a value parsed from persisted storage is a well-formed `ActivePane`.
 *
 * `activePane` is the one persisted layout field that flows into dockview's
 * `addPanel({ id })` on restore. A malformed shape (legacy `{type:"leaf"}`, a
 * session pane with a missing/blank `id`, arbitrary corrupt JSON) makes
 * `addPanel` throw during the restore effect — and because that value
 * re-persists, it throws again on the *next* reload too. Without a top-level
 * ErrorBoundary that is a permanent blank screen. Reject anything that isn't a
 * known union member here so a bad blob degrades to "no active pane" (the
 * friendly empty state) instead. Singletons must carry `id === type`; session
 * panes need a non-empty string id.
 *
 * This also retires `{type:"preview"}`, persisted by the removed markdown
 * preview feature. Rejecting it here is load-bearing: a stale preview
 * `activePane` would otherwise restore fine and then render as a silently blank
 * pane (PaneContent has no "preview" case and falls through to `null`).
 */
export function isValidActivePane(v: unknown): v is ActivePane {
  if (!v || typeof v !== "object") return false;
  const { type, id } = v as { type?: unknown; id?: unknown };
  if (typeof type !== "string" || typeof id !== "string" || id === "")
    return false;
  if (SINGLETON_TYPES.has(type)) return id === type;
  return type === "session";
}
