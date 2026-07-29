import {
  type AgentTemplate,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  permissionModeFromLegacy,
  permissionModeFromStored,
} from "@autonomos/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { isValidActivePane, SINGLETON_TYPES } from "./layout/dockview/paneId";

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
  updatedAt: number;
  /** When this session transitioned to status "exited". Only set for exited rows;
   *  missing on pre-schema records so the sidebar falls back to updatedAt. */
  exitedAt?: number;
  /** Why the session stopped — surfaced in the exited-row tooltip for triage.
   *  Missing on pre-schema records. */
  exitReason?: "user_killed" | "self_exited" | "crashed";
}

/** A Claude Code session from the SDK's listSessions() */
export interface ProjectSession {
  sessionId: string;
  summary: string;
  lastModified: number;
  gitBranch?: string;
  firstPrompt?: string;
  /** User-set title via /rename — SDK bug: currently returns undefined (v0.2.71) */
  customTitle?: string;
  /** True if this session is managed by autonomOS */
  isAutonomosAgent?: boolean;
  /** Lifecycle status for autonomOS agents */
  autonomosStatus?: "running" | "exited";
  /** Template used to spawn this agent */
  template?: string;
}

/** A project directory with its Claude Code sessions */
export interface ProjectInfo {
  path: string;
  name: string;
  sessions: ProjectSession[];
  lastActive: number;
}

export type ActivePane =
  | { type: "session"; id: string }
  | { type: "orgchart"; id: "orgchart" }
  | { type: "templates"; id: "templates" }
  | { type: "schedules"; id: "schedules" }
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
  /** Loaded templates keyed by name */
  templates: Record<string, AgentTemplate>;
  templatesLoading: boolean;
  templatesError: string | null;
  /** Loaded schedules keyed by name */
  schedules: Record<string, import("@autonomos/core").Schedule>;
  schedulesLoading: boolean;
  schedulesError: string | null;
  schedulerStatus: import("@autonomos/core").SchedulerStatus | null;
  /** Unread notification count per session ID */
  notificationCounts: Record<string, number>;
  /** Agent status per session ID (from hook events) */
  agentStatuses: Record<
    string,
    { status: string; currentTool?: string; toolDetail?: string }
  >;

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
  openOrgChart: () => void;
  openTemplates: () => void;
  openSchedules: () => void;
  fetchTemplates: () => Promise<void>;
  saveTemplate: (name: string, template: AgentTemplate) => Promise<void>;
  deleteTemplate: (name: string) => Promise<void>;
  fetchSchedules: () => Promise<void>;
  deleteSchedule: (name: string) => Promise<void>;
  runSchedule: (name: string) => Promise<void>;
  updateSchedule: (
    name: string,
    partial: Record<string, unknown>,
  ) => Promise<void>;
  fetchSchedulerStatus: () => Promise<void>;
  updateSchedulerSettings: (maxConcurrentRuns: number) => Promise<void>;
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
  body: Record<string, unknown>,
  onSuccess?: (session: SessionInfo) => void,
): Promise<void> {
  const { status } = get();
  if (status === "spawning..." || status === "resuming...") return;
  set({ status: pendingStatus });

  // Translate the legacy SessionInfo-shaped body into the new /api/agents shape.
  // - forkFrom → forkFromAgentId (same value)
  // resumeSessionId is passed THROUGH unchanged: the server resolves it against
  // both the agent store and disk (reattach a managed record OR adopt an external
  // CC session). It must NOT be rewritten to resumeAgentId — that rewrite assumed
  // agent.id == claudeSessionId, which is false for external sessions and was the
  // root cause of external-session resume 404ing (the #165 regression).
  // The server still accepts `manager` (name) at the API boundary.
  const agentBody: Record<string, unknown> = { ...body };
  if (typeof agentBody.forkFrom === "string") {
    agentBody.forkFromAgentId = agentBody.forkFrom;
    delete agentBody.forkFrom;
  }
  const res = await fetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(agentBody),
  }).catch(() => null);

  if (!res) {
    set({ status: "server unreachable" });
    return;
  }
  if (!res.ok) {
    // Surface the server's reason (e.g. "nothing to resume", template not found)
    // instead of a bare generic status — otherwise a failed resume reads as an
    // unexplained dead-end. Falls back to the generic status if there's no body.
    const err = await res.json().catch(() => null);
    const detail =
      err && typeof err.error === "string" ? err.error : `HTTP ${res.status}`;
    set({ status: `${failureStatus}: ${detail}` });
    return;
  }

  // Server returns an Agent; translate to SessionInfo for legacy code paths.
  const agent = await res.json();
  const session: SessionInfo = {
    id: agent.id,
    name: agent.name,
    status: agent.status,
    workingDirectory: agent.workingDirectory,
    provider: agent.provider,
    // SessionInfo.claudeSessionId is the dashboard's stable lookup key —
    // must equal agent.id to align with /api/agents/tree, useAgentStatusById,
    // and the /api/agents/:id/* route URLs. See fetchSessions for full rationale.
    claudeSessionId: agent.id,
    // Actual CC session id — kept distinct so callers that need to invoke
    // `claude --resume` or read CC's JSONL have access.
    providerSessionId: agent.providerSessionId,
    template: agent.template,
    manager: undefined, // managerId is a UUID; resolve to name handled in fetchSessions
    // The mode the server actually resolved for this spawn — which is not
    // necessarily the one requested (a template can supply it, and an invalid
    // request value falls back). Carry the server's answer, never the local
    // default that was sent.
    permissionMode: agent.permissionMode,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    exitedAt: agent.exitedAt,
    exitReason: agent.exitReason,
  };
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
        templates: {},
        templatesLoading: false,
        templatesError: null,
        schedules: {},
        schedulesLoading: false,
        schedulesError: null,
        schedulerStatus: null,
        notificationCounts: {},
        agentStatuses: {},
        sidebarOpen: true,
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

        fetchSessions: async () => {
          const res = await fetch("/api/agents").catch(() => null);
          if (!res?.ok) return;
          // Server returns Agent[] from /api/agents; translate to SessionInfo[]
          // for legacy dashboard code that still keys off the old shape. The
          // mapping is mechanical — id, name, status, etc. line up directly.
          const agents = (await res.json()) as Array<{
            id: string;
            name: string;
            status: "running" | "exited";
            workingDirectory: string;
            provider: string;
            providerSessionId: string;
            template?: string;
            managerId: string | null;
            project?: string;
            permissionMode?: PermissionMode;
            createdAt: number;
            updatedAt: number;
            exitedAt?: number;
            exitReason?: "user_killed" | "self_exited" | "crashed";
          }>;
          // Resolve manager name client-side so the existing UI continues to
          // surface a human-readable label without an extra round-trip.
          const byId = new Map(agents.map((a) => [a.id, a]));
          // SessionInfo.claudeSessionId is the dashboard's stable lookup key
          // — it's consumed by useAgentStatusById (HierarchyPanel) and the
          // /api/agents/:id/attach URL builder (resumeSession). For both to
          // align with /api/agents/tree (which sets node.claudeSessionId =
          // agent.id as a backward-compat alias), we set it to agent.id
          // here too. Using providerSessionId would split the key space:
          // migrated agents (id == providerSessionId) would still work, but
          // freshly-spawned agents (different UUIDs) would silently drop
          // status/activity in the org chart card view.
          const allSessions: SessionInfo[] = agents.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            workingDirectory: a.workingDirectory,
            provider: a.provider,
            claudeSessionId: a.id,
            providerSessionId: a.providerSessionId,
            template: a.template,
            manager: a.managerId ? byId.get(a.managerId)?.name : undefined,
            permissionMode: a.permissionMode,
            createdAt: a.createdAt,
            updatedAt: a.updatedAt,
            exitedAt: a.exitedAt,
            exitReason: a.exitReason,
          }));
          // Filter out exited sessions — they have no PTY and would create
          // broken terminals with perpetual WebSocket reconnect loops.
          const sessions = allSessions.filter((s) => s.status !== "exited");
          const exitedSessions = allSessions.filter(
            (s) => s.status === "exited",
          );
          const prev = get().sessions;
          const unchanged =
            prev.length === sessions.length &&
            prev.every(
              (s, i) =>
                s.id === sessions[i].id &&
                s.name === sessions[i].name &&
                s.status === sessions[i].status &&
                s.claudeSessionId === sessions[i].claudeSessionId,
            );
          const prevExited = get().exitedSessions;
          const exitedUnchanged =
            prevExited.length === exitedSessions.length &&
            prevExited.every((s, i) => s.id === exitedSessions[i].id);
          if (!unchanged || !exitedUnchanged) {
            // Prune flat-view order keys whose agent no longer exists so dead
            // entries don't accumulate for users who never reorder/pin. This
            // also retires leftover `preview:*` keys from the removed markdown
            // preview feature. Reorder/pin/unpin also re-freeze, so this only
            // matters between interactions.
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

            // If the pane we're viewing just died, fall back to a live sibling
            // from its group (or any live session) instead of blanking the dock.
            // Compute this BEFORE reconcile, which may dissolve the group.
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
            // No change in session arrays (both empty) but this was the
            // first successful fetch — flip the flag so App.tsx can act
            // (e.g. auto-open the Create Agent panel for first-run UX).
            set({ sessionsInitialFetchDone: true });
          }
        },
        fetchProjects: async () => {
          const res = await fetch("/api/projects").catch(() => null);
          if (!res?.ok) return;
          const projects: ProjectInfo[] = await res.json();
          set({ projects });
        },
        fetchNotifications: async () => {
          const res = await fetch("/api/hooks").catch(() => null);
          if (!res?.ok) return;
          const data = await res.json().catch(() => null);
          if (!data || typeof data !== "object") return;
          const counts: Record<string, number> = {};
          const statuses: Record<
            string,
            { status: string; currentTool?: string; toolDetail?: string }
          > = {};
          for (const [id, entry] of Object.entries(data)) {
            const e = entry as {
              status?: {
                status: string;
                currentTool?: string;
                toolDetail?: string;
              };
              unread?: number;
            };
            if (e.unread) counts[id] = e.unread;
            if (e.status) statuses[id] = e.status;
          }
          // Desktop notification when an agent needs input and tab isn't focused
          if (!document.hasFocus()) {
            const prev = get().agentStatuses;
            const sessions = get().sessions;
            for (const [id, s] of Object.entries(statuses)) {
              if (
                s.status === "needs_input" &&
                prev[id]?.status !== "needs_input"
              ) {
                const name =
                  sessions.find((ss) => ss.id === id)?.name ?? "Agent";
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
        },
        markNotificationsRead: async (sessionId) => {
          const res = await fetch(`/api/hooks/${sessionId}/read`, {
            method: "POST",
          }).catch(() => null);
          if (res?.ok) {
            set({
              notificationCounts: {
                ...get().notificationCounts,
                [sessionId]: 0,
              },
            });
          }
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
            const res = await fetch(`/api/agents/${claudeSessionId}/attach`, {
              method: "POST",
            }).catch(() => null);
            if (!res?.ok) {
              const err = await res
                ?.json()
                .catch(() => ({ error: "Server error" }));
              const detail =
                err?.error || err?.detail || `HTTP ${res?.status ?? "network"}`;
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
          const res = await fetch(`/api/agents/${id}/kill`, {
            method: "POST",
          }).catch(() => null);
          // Only give optimistic feedback if the kill was actually accepted —
          // otherwise the agent is still alive and retargeting would fake a
          // success the next fetchSessions() would silently reverse.
          if (!res?.ok) {
            console.error(
              `[autonomOS] killSession failed for ${id}:`,
              res ? `HTTP ${res.status}` : "network error",
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
        openOrgChart: () => {
          get().switchPane({ type: "orgchart", id: "orgchart" });
        },

        openTemplates: () => {
          get().switchPane({ type: "templates", id: "templates" });
        },

        fetchTemplates: async () => {
          const isInitialLoad = Object.keys(get().templates).length === 0;
          if (isInitialLoad) set({ templatesLoading: true });
          try {
            const res = await fetch("/api/templates");
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(
                (body as { error?: string }).error ??
                  `Server error (${res.status})`,
              );
            }
            const data = (await res.json()) as Record<string, AgentTemplate>;
            set({
              templates: data,
              templatesLoading: false,
              templatesError: null,
            });
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Failed to load templates";
            console.warn("[templates] fetch failed:", message);
            set({ templatesLoading: false, templatesError: message });
          }
        },

        saveTemplate: async (name, template) => {
          const res = await fetch("/api/templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, ...template }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(
              (body as { error?: string }).error ?? `HTTP ${res.status}`,
            );
          }
          // Optimistic update — polling will sync from server
          set((state) => ({
            templates: { ...state.templates, [name]: template },
          }));
        },

        deleteTemplate: async (name) => {
          const res = await fetch(
            `/api/templates/${encodeURIComponent(name)}`,
            { method: "DELETE" },
          );
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(
              (body as { error?: string }).error ?? `HTTP ${res.status}`,
            );
          }
          set((state) => {
            const next = { ...state.templates };
            delete next[name];
            return { templates: next };
          });
        },

        openSchedules: () => {
          get().switchPane({ type: "schedules", id: "schedules" });
        },

        fetchSchedules: async () => {
          const isInitialLoad = Object.keys(get().schedules).length === 0;
          if (isInitialLoad) set({ schedulesLoading: true });
          try {
            const res = await fetch("/api/schedules");
            if (!res.ok) {
              const body = await res.json().catch(() => ({}));
              throw new Error(
                (body as { error?: string }).error ??
                  `Server error (${res.status})`,
              );
            }
            const data = await res.json();
            set({
              schedules: data,
              schedulesLoading: false,
              schedulesError: null,
            });
          } catch (err) {
            const message =
              err instanceof Error ? err.message : "Failed to load schedules";
            console.warn("[schedules] fetch failed:", message);
            set({ schedulesLoading: false, schedulesError: message });
          }
        },

        deleteSchedule: async (name) => {
          const res = await fetch(
            `/api/schedules/${encodeURIComponent(name)}`,
            { method: "DELETE" },
          );
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(
              (body as { error?: string }).error ?? `HTTP ${res.status}`,
            );
          }
          set((state) => {
            const next = { ...state.schedules };
            delete next[name];
            return { schedules: next };
          });
        },

        runSchedule: async (name) => {
          const res = await fetch(
            `/api/schedules/${encodeURIComponent(name)}/run`,
            { method: "POST" },
          );
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(
              (body as { error?: string }).error ?? `HTTP ${res.status}`,
            );
          }
        },

        updateSchedule: async (name, partial) => {
          const res = await fetch(
            `/api/schedules/${encodeURIComponent(name)}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(partial),
            },
          );
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(
              (body as { error?: string }).error ?? `HTTP ${res.status}`,
            );
          }
          const result = await res.json();
          if (result.schedule) {
            set((state) => ({
              schedules: { ...state.schedules, [name]: result.schedule },
            }));
          }
        },

        fetchSchedulerStatus: async () => {
          try {
            const res = await fetch("/api/scheduler/status");
            if (res.ok) {
              const data = await res.json();
              set({ schedulerStatus: data });
            }
          } catch {
            // non-critical
          }
        },

        updateSchedulerSettings: async (maxConcurrentRuns) => {
          const res = await fetch("/api/scheduler/settings", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ maxConcurrentRuns }),
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(
              (body as { error?: string }).error ?? `HTTP ${res.status}`,
            );
          }
          set((state) => ({
            schedulerStatus: state.schedulerStatus
              ? { ...state.schedulerStatus, maxConcurrentRuns }
              : null,
          }));
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
          const res = await fetch(`/api/agents/${id}?force=true`, {
            method: "DELETE",
          }).catch(() => null);
          if (!res?.ok) {
            console.error(
              `[removeSession] Failed to remove session ${id}:`,
              res ? `HTTP ${res.status}` : "network error",
            );
            throw new Error("Failed to remove session");
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
