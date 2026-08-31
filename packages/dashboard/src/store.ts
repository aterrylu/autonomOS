import {
  type Agent,
  type AgentStatusMap,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type ProjectInfo,
  permissionModeFromLegacy,
  permissionModeFromStored,
} from "@autonomos/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { agentsApi, type SpawnAgentBody } from "./api/agents";
import { ApiError } from "./api/core";
import { agentsPoll, projectsPoll, statusPoll } from "./api/polls";
import { statusApi } from "./api/status";
import { isValidActivePane, SINGLETON_TYPES } from "./layout/dockview/paneId";

/** The project wire types now live in @autonomos/core alongside every other
 *  shape that crosses the HTTP boundary (ADR-078). Re-exported here so the
 *  existing `import type { ProjectInfo } from "../store"` consumers keep
 *  working while there is exactly one declaration. */
export type { ProjectInfo, ProjectSession } from "@autonomos/core";

// ── Desktop notifications ────────────────────────────────────────────

/** Request notification permission on first user interaction */
export function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function sendDesktopNotification(title: string, body: string) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(`autonomOS — ${title}`, { body, icon: "/favicon.svg" });
  }
}

/** Shallow-compare two Record objects, optionally using a custom equality function for values */
function shallowEqualRecord<V>(
  a: Record<string, V>,
  b: Record<string, V>,
  isEqual: (va: V, vb: V) => boolean = (va, vb) => va === vb,
): boolean {
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  return keysA.every((k) => k in b && isEqual(a[k], b[k]));
}

export type ThemeName = "midnight" | "daylight" | "void";

interface AppTheme {
  terminal: Record<string, string>;
  page: { bg: string; fg: string; border: string; statusFg: string };
}

export interface SessionInfo {
  id: string;
  name: string;
  status: string;
  workingDirectory: string;
  provider: string;
  /** Stable lookup key shared with /api/agents/tree's `claudeSessionId`
   *  alias and the /api/agents/:id route params. Equals `id` (the agent UUID)
   *  in the new model — NOT the Claude Code provider session id. The legacy
   *  field name is kept for now to avoid touching every consumer; if you
   *  need the actual CC session id (e.g. to invoke `claude --resume`),
   *  read `providerSessionId` instead. */
  claudeSessionId?: string;
  /** Provider-specific session id (CC's session id, Codex's, Gemini's).
   *  Use this when invoking provider CLIs directly or reading the JSONL
   *  transcript. Decoupled from `id` for fresh agents (only equal for
   *  Option-A migrated records). */
  providerSessionId?: string;
  template?: string;
  manager?: string;
  /** How much autonomy THIS agent actually has — its own record's value, not
   *  the store's `permissionMode`, which is only a browser-local default for
   *  spawns started from this dashboard. The API has always returned this
   *  field; it used to be dropped in the Agent → SessionInfo map, which is why
   *  nothing could show an agent's real mode. Optional because a pre-schema
   *  record (or a stubbed fixture) may not carry one. */
  permissionMode?: PermissionMode;
  createdAt: number;
  /** Last genuine activity (hook/turn-driven, survives restarts) — absent on
   *  records that predate the field. Preferred recency source. */
  lastActivityAt?: number;
  updatedAt: number;
  /** When this session transitioned to status "exited". Only set for exited rows;
   *  missing on pre-schema records so the sidebar falls back to updatedAt. */
  exitedAt?: number;
  /** Why the session stopped — surfaced in the exited-row tooltip for triage.
   *  Missing on pre-schema records. */
  exitReason?: "user_killed" | "self_exited" | "crashed";
  /** Name of the env preset applied to this agent at spawn (model-override
   *  backend), or undefined for the default backend. Surfaced as a gold
   *  accent-highlighted pill right after the repo·branch text on the sidebar
   *  row's bottom line. See ADR-067. */
  envPreset?: string;
  /** Count of messages queued for human hand-delivery to this (manual-queue,
   *  e.g. Gemini) agent — drives the sidebar pending-count badge. Absent/0 = no
   *  badge. Derived server-side; arrives on the /api/agents snapshot and via
   *  `agent.updated` deltas. See handoffQueue (PR #355). */
  pendingHandoffCount?: number;
}

export type ActivePane =
  | { type: "session"; id: string }
  | { type: "orgchart"; id: "orgchart" }
  | { type: "templates"; id: "templates" }
  | { type: "schedules"; id: "schedules" }
  | { type: "presets"; id: "presets" }
  | { type: "create-agent"; id: "create-agent" };

export const THEMES: Record<ThemeName, AppTheme> = {
  midnight: {
    terminal: {
      background: "#0a0e14",
      foreground: "#b3b1ad",
      cursor: "#e6b450",
      selectionBackground: "#1d3b53",
      black: "#01060e",
      red: "#ea6c73",
      green: "#91b362",
      yellow: "#e6b450",
      blue: "#53bdfa",
      magenta: "#fae38e",
      cyan: "#90e1c6",
      white: "#c7c7c7",
      // xterm 6 reserves a 14px scrollbar gutter and paints a translucent grey
      // slider by default — visible as a band next to a split divider. Make it
      // transparent at rest (gutter renders as terminal bg) and subtle on hover.
      scrollbarSliderBackground: "rgba(0,0,0,0)",
      scrollbarSliderHoverBackground: "rgba(255,255,255,0.18)",
      scrollbarSliderActiveBackground: "rgba(255,255,255,0.30)",
    },
    page: {
      bg: "#0a0e14",
      fg: "#b3b1ad",
      border: "#1c2433",
      statusFg: "#626a73",
    },
  },
  daylight: {
    terminal: {
      background: "#fafaf8",
      foreground: "#2e3440",
      cursor: "#d73a49",
      selectionBackground: "#d7e4f0",
      black: "#2e3440",
      red: "#d73a49",
      green: "#22863a",
      yellow: "#b08800",
      blue: "#0366d6",
      magenta: "#6f42c1",
      cyan: "#1b7c83",
      white: "#959da5",
      // Transparent at rest; subtle DARK slider on hover (light theme).
      scrollbarSliderBackground: "rgba(0,0,0,0)",
      scrollbarSliderHoverBackground: "rgba(0,0,0,0.18)",
      scrollbarSliderActiveBackground: "rgba(0,0,0,0.30)",
    },
    page: {
      bg: "#fafaf8",
      fg: "#2e3440",
      border: "#e1e4e8",
      statusFg: "#959da5",
    },
  },
  void: {
    terminal: {
      background: "#000000",
      foreground: "#d4d4d4",
      cursor: "#aeafad",
      selectionBackground: "#007acc",
      black: "#000000",
      red: "#f48771",
      green: "#6bdd6b",
      yellow: "#f5d76e",
      blue: "#4da6ff",
      magenta: "#dd99dd",
      cyan: "#6dd9d9",
      white: "#dddddd",
      // Transparent at rest; subtle light slider on hover (dark theme).
      scrollbarSliderBackground: "rgba(0,0,0,0)",
      scrollbarSliderHoverBackground: "rgba(255,255,255,0.18)",
      scrollbarSliderActiveBackground: "rgba(255,255,255,0.30)",
    },
    page: {
      bg: "#000000",
      fg: "#d4d4d4",
      border: "#1a1a1a",
      statusFg: "#9c9c9c",
    },
  },
};

const THEME_ORDER: ThemeName[] = ["midnight", "daylight", "void"];

const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_DEFAULT_WIDTH = 256;

function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && value in THEMES;
}

/**
 * Decide which sidebar view to show on rehydration.
 *
 * Returns the persisted view ONLY when the user explicitly chose it (the
 * `sidebarViewModeExplicit` flag is true). Otherwise — a user who never
 * toggled, or an existing install whose default view was auto-persisted
 * before this flag existed — we fall back to `defaultMode`. That fallback is
 * what makes the hierarchical default reach everyone who has not made an
 * explicit choice, not just brand-new installs.
 *
 * An explicit flag paired with a missing/invalid view is treated as
 * not-explicit, so a corrupted blob can never strand a user on a stale value.
 */
export function resolveSidebarViewMode(
  saved:
    | { sidebarViewMode?: unknown; sidebarViewModeExplicit?: unknown }
    | null
    | undefined,
  defaultMode: "flat" | "hierarchy",
): { mode: "flat" | "hierarchy"; explicit: boolean } {
  const validSaved =
    saved?.sidebarViewMode === "flat" || saved?.sidebarViewMode === "hierarchy"
      ? saved.sidebarViewMode
      : null;
  const explicit =
    saved?.sidebarViewModeExplicit === true && validSaved !== null;
  return { mode: explicit ? validSaved : defaultMode, explicit };
}

// ── Pane ordering helpers ──────────────────────────────────────────────

/** Key used in the flat-view order arrays for a session */
export function sessionOrderKey(s: SessionInfo): string {
  return s.claudeSessionId || s.id;
}

/**
 * Build the two ordered flat-view sections — pinned (top) and unpinned (below)
 * — from live sessions and the two persisted order arrays.
 *
 * - A session is pinned iff its key appears in `pinnedOrder`; membership in the
 *   array IS the pinned set (no separate flag).
 * - Sessions render in the order their key appears in the relevant array.
 * - A live session in NEITHER array is a fresh arrival and goes to the TOP of
 *   the unpinned section (spec: new agents land at the top of unpinned).
 *   Multiple simultaneous arrivals keep their `sessions` insertion order.
 *
 * Stale keys (no matching live session) are skipped here; pruning of the
 * persisted arrays happens on write (reorder/pin/unpin) and in fetchSessions.
 */
export function buildFlatSections(
  sessions: SessionInfo[],
  pinnedOrder: string[],
  unpinnedOrder: string[],
): { pinned: SessionInfo[]; unpinned: SessionInfo[] } {
  const byKey = new Map<string, SessionInfo>();
  for (const s of sessions) {
    byKey.set(sessionOrderKey(s), s);
  }

  const placed = new Set<string>();
  const take = (order: string[]): SessionInfo[] => {
    const out: SessionInfo[] = [];
    for (const key of order) {
      if (placed.has(key)) continue;
      const session = byKey.get(key);
      if (session) {
        out.push(session);
        placed.add(key);
      }
    }
    return out;
  };

  const pinned = take(pinnedOrder);
  const unpinned = take(unpinnedOrder);

  // Fresh arrivals (in neither array) prepend to the unpinned section.
  const fresh: SessionInfo[] = [];
  for (const [key, session] of byKey) {
    if (!placed.has(key)) fresh.push(session);
  }

  return { pinned, unpinned: [...fresh, ...unpinned] };
}

/**
 * Snapshot the current flat sections as key arrays — freezes fresh arrivals
 * into their displayed position and drops stale keys. The mutating flat-view
 * actions build on this so every write persists exactly what the user sees.
 */
function frozenFlatKeys(s: {
  sessions: SessionInfo[];
  pinnedOrder: string[];
  unpinnedOrder: string[];
}): { pinnedKeys: string[]; unpinnedKeys: string[] } {
  const { pinned, unpinned } = buildFlatSections(
    s.sessions,
    s.pinnedOrder,
    s.unpinnedOrder,
  );
  return {
    pinnedKeys: pinned.map(sessionOrderKey),
    unpinnedKeys: unpinned.map(sessionOrderKey),
  };
}

// ── Store ──────────────────────────────────────────────────────────────

/** How agent rows render their leading icon. "provider" shows the provider's
 *  mark with a status corner badge; "status" shows the status-only icon. */
export type AgentIconStyle = "provider" | "status";

/** A bound "workspace" (dockview engine only, ADR-047): a saved dockview
 *  arrangement plus the panes it contains. Dragging panes together binds them
 *  into a workspace; clicking any member restores the whole arrangement. The
 *  serialized layout is dockview's `SerializedDockview`, kept opaque here. */
export interface DvWorkspace {
  paneIds: string[];
  serialized: unknown;
}

/**
 * Drop dead panes from every bound workspace and dissolve any group left with
 * ≤1 member. Returns the next `{ workspaces, paneWorkspace }` maps, or `null`
 * when nothing changed (so callers skip a needless `set`).
 *
 * Without this, a killed/exited member lingers in `dvWorkspaces[wsId].paneIds`
 * forever: `syncToActive` then computes `desired` from that stale list, which can
 * never match the live `current` panels, so EVERY click on a surviving member
 * forces a full `fromJSON` teardown + terminal reconnect (the "every click
 * rebuilds the whole group" bug). Mirrors `StatusTab.handleClose`, minus the
 * dockview re-serialize (only the mounted layout can call `toJSON`) — the stale
 * `serialized` blob self-heals via syncToActive's dead-panel strip on next restore.
 */
export function reconcileDeadWorkspaces(
  workspaces: Record<string, DvWorkspace>,
  paneWorkspace: Record<string, string>,
  isDead: (paneId: string) => boolean,
): {
  workspaces: Record<string, DvWorkspace>;
  paneWorkspace: Record<string, string>;
} | null {
  let changed = false;
  const nextWs = { ...workspaces };
  const nextPw = { ...paneWorkspace };
  for (const [wsId, ws] of Object.entries(workspaces)) {
    const remaining = ws.paneIds.filter((id) => !isDead(id));
    if (remaining.length === ws.paneIds.length) continue; // no dead member here
    changed = true;
    // A group needs ≥2 members to exist; drop it entirely once ≤1 survives.
    const dissolve = remaining.length <= 1;
    // Unbind every id whose mapping still points at this workspace but which
    // isn't in the surviving set (all ids if we dissolve).
    const survivors = dissolve ? new Set<string>() : new Set(remaining);
    if (dissolve) {
      delete nextWs[wsId];
    } else {
      nextWs[wsId] = { paneIds: remaining, serialized: ws.serialized };
    }
    for (const id of ws.paneIds) {
      if (!survivors.has(id) && nextPw[id] === wsId) delete nextPw[id];
    }
  }
  return changed ? { workspaces: nextWs, paneWorkspace: nextPw } : null;
}

/**
 * Pick the pane to focus when the active session `deadId` disappears: prefer a
 * still-live sibling from its bound workspace (so a multi-pane split doesn't
 * collapse to the empty "no agent" screen just because one member died), else
 * the first other live session, else `null`. `liveSessionIds` must already
 * exclude `deadId`.
 */
export function pickActiveFallback(
  deadId: string,
  workspaces: Record<string, DvWorkspace>,
  paneWorkspace: Record<string, string>,
  liveSessionIds: string[],
): ActivePane | null {
  const live = new Set(liveSessionIds);
  const wsId = paneWorkspace[deadId];
  const ws = wsId ? workspaces[wsId] : undefined;
  if (ws) {
    const sibling = ws.paneIds.find((id) => id !== deadId && live.has(id));
    if (sibling) return { type: "session", id: sibling };
  }
  const next = liveSessionIds.find((id) => id !== deadId);
  return next ? { type: "session", id: next } : null;
}

// ── Snapshot appliers (the poll → store bridge) ────────────────────────
//
// One function per polled resource, called from TWO places that must not
// diverge: the store's own imperative action (post-mutation refresh) and the
// Sidebar's subscription to the shared poll. Keeping the store as the source of
// truth — rather than having components read poll snapshots directly — is what
// lets every existing selector keep working untouched.

/**
 * Map the server's Agent record onto the dashboard's SessionInfo view model.
 *
 * `claudeSessionId` is deliberately `agent.id`, NOT `providerSessionId`: it is
 * the dashboard's stable lookup key, consumed by useAgentStatusById
 * (HierarchyPanel) and the /api/agents/:id/* route builders, and
 * /api/agents/tree publishes the same alias. Keying off providerSessionId would
 * split the key space — migrated agents (id == providerSessionId) would still
 * work while freshly-spawned ones silently lost status/activity in the org
 * chart. The real provider session id rides along separately for callers that
 * need to invoke `claude --resume` or read CC's JSONL.
 *
 * `managerName` is resolved by the caller: /api/agents returns `managerId` (a
 * UUID), and only a caller holding the whole list can turn it into a name.
 */
function agentToSession(agent: Agent, managerName?: string): SessionInfo {
  return {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    workingDirectory: agent.workingDirectory,
    provider: agent.provider,
    claudeSessionId: agent.id,
    providerSessionId: agent.providerSessionId,
    template: agent.template,
    manager: managerName,
    // The mode the server actually resolved — which is not necessarily the one
    // requested (a template can supply it, and an invalid request value falls
    // back). Carry the server's answer, never the local default that was sent.
    permissionMode: agent.permissionMode,
    createdAt: agent.createdAt,
    lastActivityAt: agent.lastActivityAt,
    updatedAt: agent.updatedAt,
    exitedAt: agent.exitedAt,
    exitReason: agent.exitReason,
    envPreset: agent.envPreset,
    pendingHandoffCount: agent.pendingHandoffCount,
  };
}

/** Apply a `GET /api/agents` snapshot: session lists, order-key pruning,
 *  active-pane fallback, and dead-workspace reconciliation. */
export function applyAgentsSnapshot(agents: Agent[]): void {
  const set = useStore.setState;
  const get = useStore.getState;
  // Resolve manager name client-side so the existing UI continues to surface a
  // human-readable label without an extra round-trip.
  const byId = new Map(agents.map((a) => [a.id, a]));
  const allSessions = agents.map((a) =>
    agentToSession(a, a.managerId ? byId.get(a.managerId)?.name : undefined),
  );
  // Filter out exited sessions — they have no PTY and would create broken
  // terminals with perpetual WebSocket reconnect loops.
  const sessions = allSessions.filter((s) => s.status !== "exited");
  const exitedSessions = allSessions.filter((s) => s.status === "exited");
  const prev = get().sessions;
  const unchanged =
    prev.length === sessions.length &&
    prev.every(
      (s, i) =>
        s.id === sessions[i].id &&
        s.name === sessions[i].name &&
        s.status === sessions[i].status &&
        s.claudeSessionId === sessions[i].claudeSessionId &&
        // Recency must not be dropped by the short-circuit: for a steadily
        // running fleet nothing else changes, and the freshly-computed
        // lastActivityAt would be thrown away — freezing sidebar ages at
        // their page-load values (review catch).
        s.lastActivityAt === sessions[i].lastActivityAt &&
        // Same class of bug for the hand-off badge: if only the pending count
        // changes (a message queued/delivered while nothing else moves), the
        // short-circuit would freeze the badge at its page-load value.
        s.pendingHandoffCount === sessions[i].pendingHandoffCount,
    );
  const prevExited = get().exitedSessions;
  const exitedUnchanged =
    prevExited.length === exitedSessions.length &&
    prevExited.every((s, i) => s.id === exitedSessions[i].id);
  if (!unchanged || !exitedUnchanged) {
    // Prune flat-view order keys whose agent no longer exists so dead entries
    // don't accumulate for users who never reorder/pin. This also retires
    // leftover `preview:*` keys from the removed markdown preview feature.
    // Reorder/pin/unpin also re-freeze, so this only matters between
    // interactions.
    const live = new Set<string>(sessions.map(sessionOrderKey));
    const keepKey = (k: string) => live.has(k);
    const { pinnedOrder, unpinnedOrder } = get();
    const prunedPinned = pinnedOrder.filter(keepKey);
    const prunedUnpinned = unpinnedOrder.filter(keepKey);
    const orderChanged =
      prunedPinned.length !== pinnedOrder.length ||
      prunedUnpinned.length !== unpinnedOrder.length;
    set({
      sessions,
      exitedSessions,
      sessionsInitialFetchDone: true,
      ...(orderChanged && {
        pinnedOrder: prunedPinned,
        unpinnedOrder: prunedUnpinned,
      }),
    });

    const liveIds = new Set(sessions.map((s) => s.id));
    const { activePane, dvWorkspaces, dvPaneWorkspace } = get();

    // If the pane we're viewing just died, fall back to a live sibling from its
    // group (or any live session) instead of blanking the dock. Compute this
    // BEFORE reconcile, which may dissolve the group.
    if (activePane?.type === "session" && !liveIds.has(activePane.id)) {
      const fallback = pickActiveFallback(
        activePane.id,
        dvWorkspaces,
        dvPaneWorkspace,
        sessions.map((s) => s.id),
      );
      set(
        fallback
          ? { activePane: fallback, status: "connected" }
          : { activePane: null, status: "disconnected" },
      );
    }

    // Drop dead members from bound workspaces so surviving members don't
    // trigger a full teardown/rebuild on every click (see helper).
    const reconciled = reconcileDeadWorkspaces(
      dvWorkspaces,
      dvPaneWorkspace,
      (paneId) => !SINGLETON_TYPES.has(paneId) && !liveIds.has(paneId),
    );
    if (reconciled)
      set({
        dvWorkspaces: reconciled.workspaces,
        dvPaneWorkspace: reconciled.paneWorkspace,
      });
  } else if (!get().sessionsInitialFetchDone) {
    // No change in session arrays (both empty) but this was the first
    // successful fetch — flip the flag so App.tsx can act (e.g. auto-open the
    // Create Agent panel for first-run UX).
    set({ sessionsInitialFetchDone: true });
  }
}

/** Apply a `GET /api/agent-status` snapshot: unread counts, agent activity statuses,
 *  and the `needs_input` desktop notification for a backgrounded tab. */
export function applyStatusSnapshot(data: AgentStatusMap): void {
  const set = useStore.setState;
  const get = useStore.getState;
  if (!data || typeof data !== "object") return;
  const counts: Record<string, number> = {};
  const statuses: Record<
    string,
    { status: string; currentTool?: string; toolDetail?: string }
  > = {};
  for (const [id, entry] of Object.entries(data)) {
    if (entry.unread) counts[id] = entry.unread;
    if (entry.status) statuses[id] = entry.status;
  }
  // Desktop notification when an agent needs input and tab isn't focused.
  // Driven by snapshot CHANGES: an already-notified agent whose status is still
  // needs_input fails the `prev` guard, so it never double-fires.
  if (!document.hasFocus()) {
    const prev = get().agentStatuses;
    const sessions = get().sessions;
    for (const [id, s] of Object.entries(statuses)) {
      if (s.status === "needs_input" && prev[id]?.status !== "needs_input") {
        const name = sessions.find((ss) => ss.id === id)?.name ?? "Agent";
        sendDesktopNotification(name, "Needs your input");
      }
    }
  }
  const prevCounts = get().notificationCounts;
  const prevStatuses = get().agentStatuses;
  const countsChanged = !shallowEqualRecord(counts, prevCounts);
  const statusesChanged = !shallowEqualRecord(
    statuses,
    prevStatuses,
    (a, b) =>
      a.status === b.status &&
      a.currentTool === b.currentTool &&
      a.toolDetail === b.toolDetail,
  );
  if (countsChanged || statusesChanged) {
    set({ notificationCounts: counts, agentStatuses: statuses });
  }
}

/** Apply a `GET /api/projects` snapshot. */
export function applyProjectsSnapshot(projects: ProjectInfo[]): void {
  if (!Array.isArray(projects)) return;
  useStore.setState({ projects });
}

/** "network error" for an unreachable server, else "HTTP <status>" — the shape
 *  the pre-client console lines used, kept so log greps still match. */
function apiErrorLabel(err: unknown): string {
  if (err instanceof ApiError)
    return err.unreachable ? "network error" : `HTTP ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}

interface AppState {
  // Persisted
  theme: ThemeName;
  agentIconStyle: AgentIconStyle;
  /** dockview engine: bound workspaces (drag-composed groups) keyed by id. */
  dvWorkspaces: Record<string, DvWorkspace>;
  /** dockview engine: paneId → workspace id, for restore-on-click. */
  dvPaneWorkspace: Record<string, string>;
  sidebarViewMode: "flat" | "hierarchy";
  /** True once the user has explicitly chosen a sidebar view via the toggle.
   *  When false (never toggled, or a pre-flag persisted state), rehydration
   *  uses the default view rather than any auto-persisted value — this is how
   *  existing installs that never picked a view get the hierarchical default. */
  sidebarViewModeExplicit: boolean;
  activePane: ActivePane | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  /** Default tool-use autonomy applied to new spawns (per-spawn overridable). */
  permissionMode: PermissionMode;
  /** Display order of PINNED agents (top flat-view section). An agent is
   *  pinned iff its key is in this array. New pins append (bottom of pinned). */
  pinnedOrder: string[];
  /** Display order of the UNPINNED flat-view section. Fresh arrivals and
   *  freshly-unpinned agents prepend (top); see buildFlatSections. */
  unpinnedOrder: string[];
  /** Ordering of children within each hierarchy group. Key = parent name (lowercase) or "__root__". */
  hierarchyOrder: Record<string, string[]>;

  // Transient
  /** Pane ids dockview is currently showing (the panels mounted in the dock).
   *  Sourced from DockviewLayout's onDidLayoutChange; the sidebar reads it (as a
   *  Set) to mark which agent rows are on-screen. Not persisted. */
  visiblePaneIds: string[];
  status: string;
  sessions: SessionInfo[];
  exitedSessions: SessionInfo[];
  /** True once /api/agents has resolved at least once. Used by the
   *  first-run UX in App.tsx to distinguish "no agents yet" from
   *  "still loading." Once true for a tab session, stays true — the
   *  first-run flow re-fires only on a fresh tab or page reload. */
  sessionsInitialFetchDone: boolean;
  projects: ProjectInfo[];
  /** Unread notification count per session ID */
  notificationCounts: Record<string, number>;
  /** Agent status per session ID (from hook events) */
  agentStatuses: Record<
    string,
    { status: string; currentTool?: string; toolDetail?: string }
  >;
  /** Whether the keyboard-shortcut cheatsheet overlay is open. Not persisted. */
  shortcutHelpOpen: boolean;
  /** True while the primary modifier is deliberately HELD (useModKeyHold) —
   *  sidebar rows show their digit badges. Not persisted. */
  modKeyHeld: boolean;
  /** Whether the ⌘K agent quick-switcher is open. Not persisted. */
  quickSwitchOpen: boolean;
  /** The sidebar's RENDERED agent-row order (published by Sidebar, consumed by
   *  the mod+digit shortcuts and the hold-badges — ADR-066). Not persisted. */
  sidebarRowOrder: string[];

  // Actions
  cycleTheme: () => void;
  setAgentIconStyle: (style: AgentIconStyle) => void;
  /** Set the pane ids dockview is currently showing (DockviewLayout → store). */
  setVisiblePaneIds: (ids: string[]) => void;
  /** Replace the dockview workspace bindings (workspaces + paneId→ws map). */
  setDvWorkspaces: (
    workspaces: Record<string, DvWorkspace>,
    paneWorkspace: Record<string, string>,
  ) => void;
  /** Set the active pane directly without mutating layout topology. Used by
   *  the dockview bridge (ADR-047) to reflect dockview's active panel back into
   *  the store; unlike switchPane it never restores groups or collapses the
   *  legacy tree. */
  setActivePane: (pane: ActivePane | null) => void;
  toggleSidebar: () => void;
  toggleShortcutHelp: () => void;
  closeShortcutHelp: () => void;
  setModKeyHeld: (held: boolean) => void;
  setSidebarRowOrder: (ids: string[]) => void;
  toggleQuickSwitch: () => void;
  closeQuickSwitch: () => void;
  setSidebarWidth: (width: number) => void;
  resetSidebarWidth: () => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setStatus: (status: string) => void;
  switchPane: (pane: ActivePane | null) => void;
  fetchSessions: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  fetchNotifications: () => Promise<void>;
  markNotificationsRead: (sessionId: string) => Promise<void>;
  createSession: (
    workingDirectory?: string,
    opts?: {
      name?: string;
      provider?: string;
      template?: string;
      appendSystemPrompt?: string;
      permissionMode?: PermissionMode;
      envPreset?: string;
    },
  ) => Promise<void>;
  openCreateAgent: () => void;
  resumeSession: (
    claudeSessionId: string,
    cwd: string,
    name?: string,
    opts?: { isAutonomosAgent?: boolean },
  ) => Promise<void>;
  killSession: (id: string) => Promise<void>;
  /** Restart a running agent: kill the PTY, then re-attach from its record.
   *  Composed from the two existing endpoints (there is no per-agent restart
   *  route — only fleet-wide restart-all). */
  restartSession: (id: string) => Promise<void>;
  /** Reparent an agent in the org chart by manager id. `null` clears. Rethrows
   *  the typed error on failure so the caller can surface the reason. */
  setManager: (id: string, managerId: string | null) => Promise<void>;
  openOrgChart: () => void;
  openTemplates: () => void;
  openSchedules: () => void;
  openPresets: () => void;
  toggleSidebarViewMode: () => void;
  reorderHierarchy: (
    groupKey: string,
    fromIndex: number,
    toIndex: number,
  ) => void;
  removeSession: (id: string) => Promise<void>;
  /** Reorder within one flat-view section (drag-and-drop). Other section
   *  unchanged. Persists the frozen snapshot (prunes dead, freezes arrivals). */
  reorderFlat: (
    section: "pinned" | "unpinned",
    fromIndex: number,
    toIndex: number,
  ) => void;
  /** Pin an agent → BOTTOM of the pinned section (appended). */
  pinAgent: (key: string) => void;
  /** Unpin an agent → TOP of the unpinned section (prepended). */
  unpinAgent: (key: string) => void;

  remapSessionIds: (idMap: Record<string, string>) => void;
}

type SetState = (partial: Partial<AppState>) => void;
type GetState = () => AppState;

/**
 * Shared logic for createSession and resumeSession.
 * Guards against concurrent spawns and handles fetch errors uniformly.
 * Optional onSuccess callback receives the new session (used for split-pane).
 */
async function spawnSession(
  set: SetState,
  get: GetState,
  pendingStatus: string,
  failureStatus: string,
  body: SpawnAgentBody,
  onSuccess?: (session: SessionInfo) => void,
): Promise<void> {
  const { status } = get();
  if (status === "spawning..." || status === "resuming...") return;
  set({ status: pendingStatus });

  // `resumeSessionId` is passed THROUGH unchanged: the server resolves it
  // against both the agent store and disk (reattach a managed record OR adopt an
  // external CC session). It must NOT be rewritten to `resumeAgentId` — that
  // rewrite assumed agent.id == claudeSessionId, which is false for external
  // sessions and was the root cause of external-session resume 404ing (the #165
  // regression). The server still accepts `manager` (name) at the API boundary.
  //
  // The old `forkFrom → forkFromAgentId` translation is gone with the typed
  // body: SpawnAgentBody names the field `forkFromAgentId`, so no caller can
  // hand us the legacy spelling for it to rewrite (none ever did).
  let agent: Agent;
  try {
    agent = await agentsApi.spawn(body);
  } catch (err) {
    if (err instanceof ApiError && err.unreachable) {
      set({ status: "server unreachable" });
      throw new ApiError("Server unreachable", 0);
    }
    // Surface the server's reason (e.g. "nothing to resume", template not found,
    // "Env preset ... is missing its API key") instead of a bare generic status.
    // We set `status` (so isBusy resets) AND rethrow: the status string is only
    // read for the isBusy boolean and is NOT rendered anywhere, so a caller with
    // an error UI (CreateAgentPanel) must receive the throw to show the reason.
    // Before this, a keyless-preset spawn was refused loudly server-side but died
    // silently on screen (ADR-067 polish).
    set({
      status: `${failureStatus}: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }

  // Server returns an Agent; translate to SessionInfo for legacy code paths.
  // No manager name: managerId is a UUID, resolvable only against the whole
  // list, which the fetchSessions below is about to deliver anyway.
  const session = agentToSession(agent);
  if (onSuccess) {
    onSuccess(session);
  } else {
    const pane: ActivePane = { type: "session", id: session.id };
    // Use switchPane to properly exit any active group
    get().switchPane(pane);
    set({ status: "connected" });
  }
  await get().fetchSessions();
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => {
      return {
        theme: "void",
        agentIconStyle: "provider",
        dvWorkspaces: {},
        dvPaneWorkspace: {},
        sidebarViewMode: "hierarchy",
        sidebarViewModeExplicit: false,
        activePane: null,
        visiblePaneIds: [],
        status: "disconnected",
        sessions: [],
        exitedSessions: [],
        sessionsInitialFetchDone: false,
        projects: [],
        notificationCounts: {},
        agentStatuses: {},
        sidebarOpen: true,
        shortcutHelpOpen: false,
        modKeyHeld: false,
        quickSwitchOpen: false,
        sidebarRowOrder: [],
        sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
        permissionMode: DEFAULT_PERMISSION_MODE,
        pinnedOrder: [],
        unpinnedOrder: [],
        hierarchyOrder: {},

        cycleTheme: () => {
          const current = get().theme;
          const next =
            THEME_ORDER[
              (THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length
            ];
          set({ theme: next });
        },
        setAgentIconStyle: (style: AgentIconStyle) =>
          set({ agentIconStyle: style }),
        setVisiblePaneIds: (ids) => set({ visiblePaneIds: ids }),
        setDvWorkspaces: (workspaces, paneWorkspace) =>
          set({ dvWorkspaces: workspaces, dvPaneWorkspace: paneWorkspace }),
        setActivePane: (pane) => set({ activePane: pane }),
        toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
        toggleShortcutHelp: () =>
          // Mutually exclusive with the quick-switcher: stacking two modal
          // overlays leaves one dimmed behind the other's backdrop and makes
          // the first Escape appear dead (it closes the hidden one).
          set({
            shortcutHelpOpen: !get().shortcutHelpOpen,
            quickSwitchOpen: false,
          }),
        closeShortcutHelp: () => set({ shortcutHelpOpen: false }),
        setModKeyHeld: (held) => set({ modKeyHeld: held }),
        toggleQuickSwitch: () =>
          set({
            quickSwitchOpen: !get().quickSwitchOpen,
            shortcutHelpOpen: false,
          }),
        closeQuickSwitch: () => set({ quickSwitchOpen: false }),
        setSidebarRowOrder: (ids) => {
          // Published on every Sidebar render commit — skip no-op updates so
          // subscribers don't re-render on unchanged order.
          const prev = get().sidebarRowOrder;
          if (
            prev.length === ids.length &&
            prev.every((id, i) => id === ids[i])
          )
            return;
          set({ sidebarRowOrder: ids });
        },
        setSidebarWidth: (width: number) => {
          if (!Number.isFinite(width)) return;
          set({
            sidebarWidth: Math.max(
              SIDEBAR_MIN_WIDTH,
              Math.min(width, window.innerWidth * 0.5),
            ),
          });
        },
        resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_DEFAULT_WIDTH }),
        setPermissionMode: (mode) => set({ permissionMode: mode }),
        setStatus: (status) => set({ status }),
        switchPane: (pane) => {
          // Clicking a sidebar item is NAVIGATION (ADR-047). DockviewLayout owns
          // the arrangement — it reacts to activePane and either restores the
          // pane's bound workspace (drag-composed group) or shows it solo. So
          // clicking only needs to set the active pane here.
          if (!pane) {
            set({ activePane: null });
            return;
          }
          set({ activePane: pane });
        },

        // The three query actions below refresh the SHARED poll rather than
        // issuing a side-channel GET: a post-mutation refetch then updates the
        // poll's snapshot too, so subscribers aren't left showing pre-mutation
        // data until their next tick. Each applies the resulting snapshot
        // itself, which is what keeps them working when nothing is subscribed
        // (the Sidebar — the only subscriber — unmounts when it is collapsed).
        fetchSessions: async () => {
          await agentsPoll.refresh();
          const { data } = agentsPoll.getSnapshot();
          if (data) applyAgentsSnapshot(data);
        },
        fetchProjects: async () => {
          await projectsPoll.refresh();
          const { data } = projectsPoll.getSnapshot();
          if (data) applyProjectsSnapshot(data);
        },
        fetchNotifications: async () => {
          await statusPoll.refresh();
          const { data } = statusPoll.getSnapshot();
          if (data) applyStatusSnapshot(data);
        },
        markNotificationsRead: async (sessionId) => {
          try {
            await statusApi.markRead(sessionId);
          } catch (err) {
            // Unchanged from the pre-client behavior: a failed mark-read leaves
            // the badge alone rather than faking a cleared count the next poll
            // tick would restore.
            console.warn(
              `[autonomOS] markNotificationsRead failed for ${sessionId}:`,
              apiErrorLabel(err),
            );
            return;
          }
          set({
            notificationCounts: {
              ...get().notificationCounts,
              [sessionId]: 0,
            },
          });
        },
        createSession: async (workingDirectory = "~", opts) => {
          await spawnSession(
            set,
            get,
            "spawning...",
            "failed to create session",
            {
              workingDirectory,
              permissionMode: opts?.permissionMode ?? get().permissionMode,
              name: opts?.name,
              provider: opts?.provider,
              template: opts?.template,
              appendSystemPrompt: opts?.appendSystemPrompt,
              envPreset: opts?.envPreset,
            },
          );
        },

        openCreateAgent: () => {
          get().switchPane({ type: "create-agent", id: "create-agent" });
        },
        // `_name` is accepted but deliberately unused — callers (the Projects
        // panel) pass the session summary, which must NOT become the agent's
        // name or reach `--name`. See the spawnSession call below.
        resumeSession: async (claudeSessionId, cwd, _name, opts) => {
          // Match on BOTH id-spaces. The Projects panel keys sessions by the CC
          // session id, while SessionInfo.claudeSessionId is the agent id — equal
          // for unified-id agents, but NOT for split-id ones (spawned post-#165,
          // before the id unification). Matching only the agent id misses an
          // already-running split-id agent, falls through to a spawn, and the
          // server rejects it with "already attached" — an error where the right
          // outcome is silently switching to the pane that's already open.
          // The `!!claudeSessionId` guard is load-bearing: both SessionInfo id
          // fields are optional, so without it a malformed entry with an
          // undefined id would match ANY session whose providerSessionId is also
          // undefined — switching the user to an arbitrary pane.
          const matchesId = (s: SessionInfo) =>
            !!claudeSessionId &&
            (s.claudeSessionId === claudeSessionId ||
              s.providerSessionId === claudeSessionId);
          const existing = get().sessions.find(matchesId);
          if (existing) {
            const pane: ActivePane = { type: "session", id: existing.id };
            get().switchPane(pane);
            set({ status: "connected" });
            return;
          }

          // For exited autonomOS agents, use the dedicated resume endpoint
          // which re-resolves the template and restores full config.
          if (opts?.isAutonomosAgent) {
            set({ status: "resuming..." });
            try {
              await agentsApi.attach(claudeSessionId);
            } catch (err) {
              // ApiError.message is the server's own `error` envelope field
              // when it sent one, so the surfaced reason is unchanged.
              const detail = err instanceof Error ? err.message : String(err);
              console.error("Failed to resume autonomOS session:", detail);
              set({ status: `resume failed: ${detail}` });
              return;
            }
            await get().fetchSessions();
            // Same dual-id match: for a split-id agent (the case the /attach
            // providerSessionId fallback now unblocks) an agent-id-only lookup
            // misses and drops the user into the retry path instead of switching.
            const resumed = get().sessions.find(matchesId);
            if (resumed) {
              get().switchPane({ type: "session", id: resumed.id });
              set({ status: "connected" });
            } else {
              // Session created but not yet visible — poll once more
              console.warn(
                `Resume API succeeded but session ${claudeSessionId} not found — retrying fetch`,
              );
              setTimeout(async () => {
                await get().fetchSessions();
                const retry = get().sessions.find(matchesId);
                if (retry) {
                  get().switchPane({ type: "session", id: retry.id });
                  set({ status: "connected" });
                } else {
                  set({ status: "session resumed — click to switch" });
                }
              }, 1000);
            }
            return;
          }

          // Deliberately NOT forwarding `name`. The Projects panel passes the
          // session's *summary* — for a terminal-started session with no
          // customTitle that's an SDK-generated sentence like "Fixing the auth
          // token refresh bug". Before this PR the external branch 404'd, so
          // this was unreachable; now it would (a) become the agent's record
          // name and therefore its `agent://<name>` address for send /
          // set_manager / kill_agent, and (b) be passed as `--name` on the
          // resume, which rewrites customTitle on the USER'S OWN external
          // session. Let the server mint `<dir> · <id>` instead; the user can
          // /rename afterwards.
          // permissionMode is deliberately OMITTED, not set to this browser's
          // default. `resumeSessionId` resolves polymorphically on the server:
          // it adopts a genuinely external session (no record → the fallback
          // chain applies, which is what we want), but it REATTACHES a managed
          // record when the id matches one — and this panel can show a managed
          // agent as external, because it matches on providerSessionId while
          // the ADR-049 crash net regenerates exactly that field, orphaning the
          // agent's original JSONL under its still-valid agent id.
          //
          // Sending an explicit mode here would count as "the caller asked for
          // this" and permanently overwrite that agent's record with whatever
          // this browser tab's dropdown last said. Omitting it lets the server
          // preserve the record on a reattach and apply the default only where
          // there is genuinely no record to preserve.
          await spawnSession(
            set,
            get,
            "resuming...",
            "failed to resume session",
            {
              workingDirectory: cwd,
              resumeSessionId: claudeSessionId,
            },
          );
        },
        killSession: async (id) => {
          // Only give optimistic feedback if the kill was actually accepted —
          // otherwise the agent is still alive and retargeting would fake a
          // success the next fetchSessions() would silently reverse.
          try {
            await agentsApi.kill(id);
          } catch (err) {
            console.error(
              `[autonomOS] killSession failed for ${id}:`,
              apiErrorLabel(err),
            );
            await get().fetchSessions();
            return;
          }
          const { activePane, sessions, dvWorkspaces, dvPaneWorkspace } = get();
          if (activePane?.type === "session" && activePane.id === id) {
            // Immediate feedback: retarget to a live sibling/session rather than
            // blanking the dock. fetchSessions() below reconciles the workspace
            // maps once the server confirms the kill.
            const liveIds = sessions
              .filter((s) => s.id !== id)
              .map((s) => s.id);
            const fallback = pickActiveFallback(
              id,
              dvWorkspaces,
              dvPaneWorkspace,
              liveIds,
            );
            set(
              fallback
                ? { activePane: fallback, status: "connected" }
                : { activePane: null, status: "disconnected" },
            );
          }
          await get().fetchSessions();
        },
        restartSession: async (id) => {
          // No per-agent restart endpoint exists (only restart-all), so compose
          // kill → attach. killAttachment marks the record exited synchronously
          // before responding, so attach won't hit the "already running" guard.
          // Handle the two legs separately: a kill that doesn't land (409 — the
          // agent was already dead) is fine, so proceed to attach anyway; only a
          // failed ATTACH is a real problem (it leaves the agent stopped). No
          // client toast channel exists yet, so a failed attach is logged loudly
          // and the agent shows as stopped (resumable) — surfacing it in-UI is a
          // follow-up.
          try {
            await agentsApi.kill(id);
          } catch (err) {
            console.warn(
              `[autonomOS] restartSession: kill of ${id} did not land, continuing to attach:`,
              apiErrorLabel(err),
            );
          }
          let attached = false;
          try {
            await agentsApi.attach(id);
            attached = true;
          } catch (err) {
            console.error(
              `[autonomOS] restartSession: attach of ${id} FAILED — agent left stopped:`,
              apiErrorLabel(err),
            );
          }
          await get().fetchSessions();
          // Re-open the pane. The kill dropped this id from `sessions` and
          // retargeted the active pane to a live sibling (pickActiveFallback),
          // so without this, Restart closes the terminal you were watching and
          // jumps you to another agent while the restarted one runs with no pane.
          // Only when the attach actually landed (else there is nothing to show).
          if (attached) get().switchPane({ type: "session", id });
        },
        setManager: async (id, managerId) => {
          // Set by exact id (skips the server's name resolution + running/recent
          // tie-break); `null` clears. Rethrow like removeSession so the caller
          // can surface the reason — the client cycle filter can't see cycles
          // that route through an EXITED intermediary, so a 409 is still possible.
          try {
            await agentsApi.manager(id, { managerId });
          } catch (err) {
            console.error(
              `[autonomOS] setManager failed for ${id}:`,
              apiErrorLabel(err),
            );
            await get().fetchSessions();
            throw err;
          }
          await get().fetchSessions();
        },
        openOrgChart: () => {
          get().switchPane({ type: "orgchart", id: "orgchart" });
        },

        openTemplates: () => {
          get().switchPane({ type: "templates", id: "templates" });
        },

        openSchedules: () => {
          get().switchPane({ type: "schedules", id: "schedules" });
        },

        openPresets: () => {
          get().switchPane({ type: "presets", id: "presets" });
        },

        toggleSidebarViewMode: () => {
          set({
            sidebarViewMode:
              get().sidebarViewMode === "flat" ? "hierarchy" : "flat",
            // Mark the view as explicitly chosen so it survives rehydration
            // (otherwise the default view would win — see resolveSidebarViewMode).
            sidebarViewModeExplicit: true,
          });
        },

        reorderHierarchy: (groupKey, fromIndex, toIndex) => {
          const prev = get().hierarchyOrder;
          const order = prev[groupKey] ? [...prev[groupKey]] : [];
          // If the order array is empty, it hasn't been initialized yet.
          // The caller should pass the current name list first time.
          if (order.length === 0) return;
          // Bounds guard (mirrors reorderFlat): a drop with stale indices — the
          // sibling list changed mid-drag (agent added/removed/renamed) — would
          // otherwise splice `undefined` into the persisted order, poisoning
          // hierarchyOrder[groupKey] with an entry matching no agent. No-op instead.
          if (
            fromIndex < 0 ||
            toIndex < 0 ||
            fromIndex >= order.length ||
            toIndex >= order.length ||
            fromIndex === toIndex
          )
            return;
          const [moved] = order.splice(fromIndex, 1);
          order.splice(toIndex, 0, moved);
          set({ hierarchyOrder: { ...prev, [groupKey]: order } });
        },

        removeSession: async (id) => {
          try {
            await agentsApi.remove(id, { force: true });
          } catch (err) {
            console.error(
              `[removeSession] Failed to remove session ${id}:`,
              apiErrorLabel(err),
            );
            // Rethrow the typed error rather than a generic one: the caller
            // (the org chart's confirm dialog) keeps its dialog open on any
            // throw, and the ApiError carries the server's actual reason.
            throw err;
          }
          await get().fetchSessions();
        },

        reorderFlat: (section, fromIndex, toIndex) => {
          const { pinnedKeys, unpinnedKeys } = frozenFlatKeys(get());
          const target = section === "pinned" ? pinnedKeys : unpinnedKeys;
          // Out-of-range or no-op: still persist the frozen snapshot so the drag
          // prunes dead keys and freezes arrivals rather than doing nothing.
          if (
            fromIndex >= 0 &&
            toIndex >= 0 &&
            fromIndex < target.length &&
            toIndex < target.length &&
            fromIndex !== toIndex
          ) {
            const [moved] = target.splice(fromIndex, 1);
            target.splice(toIndex, 0, moved);
          }
          set({ pinnedOrder: pinnedKeys, unpinnedOrder: unpinnedKeys });
        },

        pinAgent: (key) => {
          const { pinnedKeys, unpinnedKeys } = frozenFlatKeys(get());
          if (pinnedKeys.includes(key)) return; // already pinned
          set({
            pinnedOrder: [...pinnedKeys, key], // → BOTTOM of pinned
            unpinnedOrder: unpinnedKeys.filter((k) => k !== key),
          });
        },

        unpinAgent: (key) => {
          const { pinnedKeys, unpinnedKeys } = frozenFlatKeys(get());
          if (!pinnedKeys.includes(key)) return; // not pinned
          set({
            pinnedOrder: pinnedKeys.filter((k) => k !== key),
            // → TOP of unpinned, treated as a fresh appearance.
            unpinnedOrder: [key, ...unpinnedKeys.filter((k) => k !== key)],
          });
        },

        remapSessionIds: (idMap) => {
          const { activePane, pinnedOrder, unpinnedOrder } = get();

          // Helper: remap a pane reference
          const remapPane = (p: ActivePane | null): ActivePane | null => {
            if (!p || p.type !== "session") return p;
            const newId = idMap[p.id];
            return newId ? { ...p, id: newId } : p;
          };

          // Remap both flat-view order arrays — keys are raw claudeSessionId or
          // internal id (no prefix). claudeSessionId doesn't change on restart,
          // so only entries that used the internal id need remapping.
          const remapKey = (key: string) => idMap[key] ?? key;

          set({
            activePane: remapPane(activePane),
            pinnedOrder: pinnedOrder.map(remapKey),
            unpinnedOrder: unpinnedOrder.map(remapKey),
          });

          // Fetch new session list
          get().fetchSessions();
        },
      };
    },
    {
      name: "autonomos",
      partialize: (state) => ({
        theme: state.theme,
        agentIconStyle: state.agentIconStyle,
        dvWorkspaces: state.dvWorkspaces,
        dvPaneWorkspace: state.dvPaneWorkspace,
        sidebarViewMode: state.sidebarViewMode,
        sidebarViewModeExplicit: state.sidebarViewModeExplicit,
        activePane: state.activePane,
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        permissionMode: state.permissionMode,
        pinnedOrder: state.pinnedOrder,
        unpinnedOrder: state.unpinnedOrder,
        hierarchyOrder: state.hierarchyOrder,
        projects: state.projects,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Record<string, unknown>;
        const merged = { ...current };

        if (isThemeName(saved?.theme)) merged.theme = saved.theme;
        if (
          saved?.agentIconStyle === "provider" ||
          saved?.agentIconStyle === "status"
        )
          merged.agentIconStyle = saved.agentIconStyle;
        // Validate persisted dockview workspaces: drop any entry whose shape
        // doesn't match { paneIds: string[]; serialized } so a corrupt/stale
        // blob degrades to "no saved workspaces" instead of throwing later when
        // DockviewLayout reads `paneIds` / hands `serialized` to api.fromJSON().
        if (
          saved?.dvWorkspaces &&
          typeof saved.dvWorkspaces === "object" &&
          !Array.isArray(saved.dvWorkspaces)
        ) {
          const clean: Record<string, DvWorkspace> = {};
          for (const [k, v] of Object.entries(
            saved.dvWorkspaces as Record<string, unknown>,
          )) {
            if (
              v &&
              typeof v === "object" &&
              Array.isArray((v as DvWorkspace).paneIds) &&
              (v as DvWorkspace).paneIds.every(
                (id) => typeof id === "string",
              ) &&
              // serialized is dockview's SerializedDockview (always an object
              // from api.toJSON()); reject a primitive/null blob so it can't
              // reach api.fromJSON() and throw during restore.
              typeof (v as DvWorkspace).serialized === "object" &&
              (v as DvWorkspace).serialized !== null
            ) {
              clean[k] = v as DvWorkspace;
            } else {
              console.warn(
                `[autonomOS] Dropping malformed persisted workspace "${k}"`,
              );
            }
          }
          merged.dvWorkspaces = clean;
        }
        if (
          saved?.dvPaneWorkspace &&
          typeof saved.dvPaneWorkspace === "object" &&
          !Array.isArray(saved.dvPaneWorkspace)
        ) {
          const validWs = merged.dvWorkspaces;
          const clean: Record<string, string> = {};
          for (const [paneId, wsId] of Object.entries(
            saved.dvPaneWorkspace as Record<string, unknown>,
          )) {
            // Only keep reverse-map entries that point at a workspace that
            // survived validation — keeps the two maps consistent.
            if (typeof wsId === "string" && validWs[wsId]) clean[paneId] = wsId;
          }
          merged.dvPaneWorkspace = clean;
        }
        if (typeof saved?.sidebarOpen === "boolean")
          merged.sidebarOpen = saved.sidebarOpen;
        if (
          typeof saved?.sidebarWidth === "number" &&
          Number.isFinite(saved.sidebarWidth) &&
          saved.sidebarWidth >= SIDEBAR_MIN_WIDTH
        )
          merged.sidebarWidth = Math.min(
            saved.sidebarWidth,
            window.innerWidth * 0.5,
          );
        // Accept a current permissionMode, or this enum's pre-rename spelling
        // ("default" → "ask"); otherwise migrate legacy autonomousMode
        // (true→bypass, false→ask). Browsers hold whichever spelling was
        // current when the user last picked one, so both must load.
        // See ADR-045 + the permission-mode refactor.
        const storedMode = permissionModeFromStored(saved?.permissionMode);
        if (storedMode !== undefined) {
          merged.permissionMode = storedMode;
        } else {
          const migrated = permissionModeFromLegacy(
            typeof saved?.autonomousMode === "boolean"
              ? saved.autonomousMode
              : undefined,
          );
          if (migrated) merged.permissionMode = migrated;
        }
        // Restore the saved view only if explicitly chosen; otherwise keep the
        // new default (current.sidebarViewMode). See resolveSidebarViewMode.
        const view = resolveSidebarViewMode(saved, current.sidebarViewMode);
        merged.sidebarViewMode = view.mode;
        merged.sidebarViewModeExplicit = view.explicit;
        if (
          saved?.hierarchyOrder &&
          typeof saved.hierarchyOrder === "object" &&
          !Array.isArray(saved.hierarchyOrder)
        )
          merged.hierarchyOrder = saved.hierarchyOrder as Record<
            string,
            string[]
          >;

        // Migrate old sessionId → activePane. Validate the persisted shape:
        // activePane is the one layout field that reaches dockview's
        // addPanel({ id }) on restore, so a malformed blob (legacy shape, blank
        // id) must degrade to "no active pane" rather than throw every reload.
        if (isValidActivePane(saved?.activePane)) {
          merged.activePane = saved.activePane;
        } else if (typeof saved?.sessionId === "string") {
          merged.activePane = { type: "session", id: saved.sessionId };
        } else {
          // Log only when a value was actually present but rejected — mirrors the
          // malformed-workspace warning above so a non-restoring last-viewed pane
          // is diagnosable; a legitimately-absent value stays quiet.
          if (saved?.activePane != null)
            console.warn("[autonomOS] Dropping malformed persisted activePane");
          merged.activePane = null;
        }

        // Flat-view order. New keys (pinnedOrder/unpinnedOrder) win when
        // present. Otherwise migrate the legacy single list (paneOrder, or the
        // even-older sessionOrder) into the unpinned section — everyone starts
        // unpinned with their manual order intact, nothing pre-pinned.
        if (Array.isArray(saved?.pinnedOrder)) {
          merged.pinnedOrder = saved.pinnedOrder as string[];
        }
        if (Array.isArray(saved?.unpinnedOrder)) {
          merged.unpinnedOrder = saved.unpinnedOrder as string[];
        } else if (Array.isArray(saved?.paneOrder)) {
          merged.unpinnedOrder = saved.paneOrder as string[];
        } else if (Array.isArray(saved?.sessionOrder)) {
          merged.unpinnedOrder = saved.sessionOrder as string[];
        }

        if (Array.isArray(saved?.projects)) {
          merged.projects = saved.projects as ProjectInfo[];
        }

        return merged;
      },
    },
  ),
);
