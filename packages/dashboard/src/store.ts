import type { AgentTemplate } from "@autonomos/core";
import { create } from "zustand";
import { persist } from "zustand/middleware";

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

import {
  activeTabPane,
  addTab,
  allLeafIds,
  allTabPanes,
  derivedActivePane,
  findLeaf,
  findLeafByPaneId,
  insertLeaf,
  type LayoutNode,
  makeRootLeaf,
  migrateLayout,
  nextLeafId,
  pruneStaleSessionTabs,
  removeLeaf,
  removeTab,
  type SplitDirection,
  type SplitSide,
  setActiveTab,
  setLeafPane,
  updateBranchSizes,
} from "./layout/layoutTree";

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

export interface PreviewPaneInfo {
  id: string;
  filePath: string;
  title: string;
}

export type ActivePane =
  | { type: "session"; id: string }
  | { type: "preview"; id: string }
  | { type: "orgchart"; id: "orgchart" }
  | { type: "templates"; id: "templates" }
  | { type: "schedules"; id: "schedules" }
  | { type: "create-agent"; id: "create-agent" };

// ── Pane Groups ───────────────────────────────────────────────────────

export const GROUP_COLORS = [
  "#53bdfa", // blue
  "#91b362", // green
  "#e6b450", // yellow
  "#ea6c73", // red
  "#90e1c6", // cyan
  "#fae38e", // magenta
];

let _groupCounter = 0;

export interface PaneGroup {
  id: string;
  name: string;
  color: string;
  memberPaneIds: string[];
  savedLayout: LayoutNode;
  savedFocusedLeafId: string;
}

/** Find which group a pane belongs to (if any). */
export function getGroupForPane(
  groups: Record<string, PaneGroup>,
  paneId: string,
): PaneGroup | null {
  for (const g of Object.values(groups)) {
    if (Array.isArray(g?.memberPaneIds) && g.memberPaneIds.includes(paneId))
      return g;
  }
  return null;
}

/** Pick the next unused group color, cycling through GROUP_COLORS. */
function nextGroupColor(groups: Record<string, PaneGroup>): string {
  const usedColors = new Set(Object.values(groups).map((g) => g.color));
  return (
    GROUP_COLORS.find((c) => !usedColors.has(c)) ??
    GROUP_COLORS[_groupCounter % GROUP_COLORS.length]
  );
}

/**
 * Extend the active group with a new pane, or create a new group from
 * the existing layout panes plus the new pane. Returns the updated groups
 * record and the new active group id.
 */
function addPaneToGroup(
  groups: Record<string, PaneGroup>,
  activeGroupId: string | null,
  existingPanes: ActivePane[],
  newPaneId: string,
  newLayout: LayoutNode,
  newFocusedLeafId: string,
): { groups: Record<string, PaneGroup>; activeGroupId: string } {
  const updated = { ...groups };

  if (activeGroupId && updated[activeGroupId]) {
    updated[activeGroupId] = {
      ...updated[activeGroupId],
      memberPaneIds: [...updated[activeGroupId].memberPaneIds, newPaneId],
      savedLayout: newLayout,
      savedFocusedLeafId: newFocusedLeafId,
    };
    return { groups: updated, activeGroupId };
  }

  const memberIds = [...existingPanes.map((p) => p.id), newPaneId];
  const color = nextGroupColor(updated);
  _groupCounter++;
  const groupId = `group-${Date.now()}-${_groupCounter}`;
  const groupNum = Object.keys(updated).length + 1;
  updated[groupId] = {
    id: groupId,
    name: `Split ${groupNum}`,
    color,
    memberPaneIds: memberIds,
    savedLayout: newLayout,
    savedFocusedLeafId: newFocusedLeafId,
  };
  return { groups: updated, activeGroupId: groupId };
}

/**
 * After a layout mutation, prune the active group's member list and dissolve
 * the group when the split collapses to a single region.
 *
 * A group represents a *split view* (multiple leaves/regions), not merely a
 * set of panes. So dissolution is keyed off the number of leaves in the new
 * layout, not the pane count — collapsing two split regions into one leaf with
 * two tabs (e.g. a move-to-center drop) is no longer a split and must dissolve
 * the group, even though both panes survive as tabs. This mirrors the rest of
 * the codebase, which treats `allLeafIds(layout).length > 1` as "a split is
 * showing" (see App.tsx Ctrl+W handling).
 */
function syncGroupAfterRemoval(
  groups: Record<string, PaneGroup>,
  activeGroupId: string | null,
  newLayout: LayoutNode,
  newFocusedLeafId: string,
): { groups: Record<string, PaneGroup>; activeGroupId: string | null } {
  const updated = { ...groups };
  let newActiveGroupId = activeGroupId;

  if (activeGroupId && updated[activeGroupId]) {
    const group = updated[activeGroupId];
    const remainingIds = new Set(allTabPanes(newLayout).map((p) => p.id));
    const updatedMembers = group.memberPaneIds.filter((id) =>
      remainingIds.has(id),
    );

    if (allLeafIds(newLayout).length <= 1 || updatedMembers.length <= 1) {
      delete updated[activeGroupId];
      newActiveGroupId = null;
    } else {
      updated[activeGroupId] = {
        ...group,
        memberPaneIds: updatedMembers,
        savedLayout: newLayout,
        savedFocusedLeafId: newFocusedLeafId,
      };
    }
  }

  return { groups: updated, activeGroupId: newActiveGroupId };
}

/**
 * Save a layout + focus snapshot into the active group (if one exists).
 * Returns a partial state update for `groups`, or an empty object if no group is active.
 */
function saveGroupSnapshot(
  groups: Record<string, PaneGroup>,
  activeGroupId: string | null,
  layout: LayoutNode,
  focusedLeafId: string,
): Partial<Pick<AppState, "groups">> {
  if (!activeGroupId || !groups[activeGroupId]) return {};
  return {
    groups: {
      ...groups,
      [activeGroupId]: {
        ...groups[activeGroupId],
        savedLayout: layout,
        savedFocusedLeafId: focusedLeafId,
      },
    },
  };
}

/** Sidebar item — unified type for sessions and previews */
export type SidebarItem =
  | { type: "session"; data: SessionInfo }
  | { type: "preview"; data: PreviewPaneInfo };

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
function sessionOrderKey(s: SessionInfo): string {
  return s.claudeSessionId || s.id;
}

/** Key used in the flat-view order arrays for a preview */
function previewOrderKey(id: string): string {
  return `preview:${id}`;
}

/**
 * Build the two ordered flat-view sections — pinned (top) and unpinned (below)
 * — from live sessions + previews and the two persisted order arrays.
 *
 * - An item is pinned iff its key appears in `pinnedOrder`; membership in the
 *   array IS the pinned set (no separate flag).
 * - Items render in the order their key appears in the relevant array.
 * - A live item in NEITHER array is a fresh arrival and goes to the TOP of the
 *   unpinned section (spec: new agents land at the top of unpinned). Multiple
 *   simultaneous arrivals keep their sessions/previews insertion order.
 * - Previews are never pinned, so they only ever appear in the unpinned section.
 *
 * Stale keys (no matching live item) are skipped here; pruning of the persisted
 * arrays happens on write (reorder/pin/unpin) and in fetchSessions.
 */
export function buildFlatSections(
  sessions: SessionInfo[],
  previews: PreviewPaneInfo[],
  pinnedOrder: string[],
  unpinnedOrder: string[],
): { pinned: SidebarItem[]; unpinned: SidebarItem[] } {
  const itemsByKey = new Map<string, SidebarItem>();
  for (const s of sessions) {
    itemsByKey.set(sessionOrderKey(s), { type: "session", data: s });
  }
  for (const p of previews) {
    itemsByKey.set(previewOrderKey(p.id), { type: "preview", data: p });
  }

  const placed = new Set<string>();
  const take = (order: string[]): SidebarItem[] => {
    const out: SidebarItem[] = [];
    for (const key of order) {
      if (placed.has(key)) continue;
      const item = itemsByKey.get(key);
      if (item) {
        out.push(item);
        placed.add(key);
      }
    }
    return out;
  };

  const pinned = take(pinnedOrder);
  const unpinned = take(unpinnedOrder);

  // Fresh arrivals (in neither array) prepend to the unpinned section.
  const fresh: SidebarItem[] = [];
  for (const [key, item] of itemsByKey) {
    if (!placed.has(key)) fresh.push(item);
  }

  return { pinned, unpinned: [...fresh, ...unpinned] };
}

/** Get the order-array key for a SidebarItem */
export function sidebarItemKey(item: SidebarItem): string {
  if (item.type === "session") return sessionOrderKey(item.data);
  return previewOrderKey(item.data.id);
}

/**
 * Snapshot the current flat sections as key arrays — freezes fresh arrivals
 * into their displayed position and drops stale keys. The mutating flat-view
 * actions build on this so every write persists exactly what the user sees.
 */
function frozenFlatKeys(s: {
  sessions: SessionInfo[];
  previewPanes: PreviewPaneInfo[];
  pinnedOrder: string[];
  unpinnedOrder: string[];
}): { pinnedKeys: string[]; unpinnedKeys: string[] } {
  const { pinned, unpinned } = buildFlatSections(
    s.sessions,
    s.previewPanes,
    s.pinnedOrder,
    s.unpinnedOrder,
  );
  return {
    pinnedKeys: pinned.map(sidebarItemKey),
    unpinnedKeys: unpinned.map(sidebarItemKey),
  };
}

/** Get the ActivePane for a SidebarItem */
export function sidebarItemPane(item: SidebarItem): ActivePane {
  return item.type === "session"
    ? { type: "session", id: item.data.id }
    : { type: "preview", id: item.data.id };
}

// ── Store ──────────────────────────────────────────────────────────────

/** How agent rows render their leading icon. "provider" shows the provider's
 *  mark with a status corner badge; "status" shows the status-only icon. */
export type AgentIconStyle = "provider" | "status";

interface AppState {
  // Persisted
  theme: ThemeName;
  agentIconStyle: AgentIconStyle;
  sidebarViewMode: "flat" | "hierarchy";
  /** True once the user has explicitly chosen a sidebar view via the toggle.
   *  When false (never toggled, or a pre-flag persisted state), rehydration
   *  uses the default view rather than any auto-persisted value — this is how
   *  existing installs that never picked a view get the hierarchical default. */
  sidebarViewModeExplicit: boolean;
  activePane: ActivePane | null;
  sidebarOpen: boolean;
  sidebarWidth: number;
  autonomousMode: boolean;
  /** Display order of PINNED agents (top flat-view section). An agent is
   *  pinned iff its key is in this array. New pins append (bottom of pinned). */
  pinnedOrder: string[];
  /** Display order of the UNPINNED flat-view section (agents + previews). Fresh
   *  arrivals and freshly-unpinned agents prepend (top); see buildFlatSections. */
  unpinnedOrder: string[];
  /** Ordering of children within each hierarchy group. Key = parent name (lowercase) or "__root__". */
  hierarchyOrder: Record<string, string[]>;
  previewPanes: PreviewPaneInfo[];
  layout: LayoutNode;
  focusedLeafId: string;
  groups: Record<string, PaneGroup>;
  activeGroupId: string | null;

  // Transient
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
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  resetSidebarWidth: () => void;
  toggleAutonomousMode: () => void;
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
      autonomousMode?: boolean;
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
  openPreview: (filePath: string) => void;
  closePreview: (id: string) => void;
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

  // Layout / split-pane actions
  splitLeafWithPane: (
    leafId: string,
    direction: SplitDirection,
    newSide: SplitSide,
    pane: ActivePane | null,
  ) => void;
  createSessionIntoLeaf: (
    leafId: string,
    direction: SplitDirection,
    newSide: SplitSide,
    cwd?: string,
  ) => Promise<void>;
  setLeafPane: (leafId: string, pane: ActivePane | null) => void;
  addTabToLeaf: (leafId: string, pane: ActivePane) => void;
  closeTab: (leafId: string, tabId: string) => void;
  switchTabInLeaf: (leafId: string, tabIndex: number) => void;
  setLeafSizes: (branchId: string, sizes: [number, number]) => void;
  setFocusedLeaf: (leafId: string) => void;
  closeLeaf: (leafId: string) => void;
  movePaneToLeaf: (
    paneId: string,
    targetLeafId: string,
    zone: "center" | "north" | "south" | "east" | "west",
  ) => void;
  removeFromGroup: (groupId: string, paneId: string) => void;
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
  // - resumeSessionId → resumeAgentId (same value: agent.id == old claudeSessionId)
  // - forkFrom → forkFromAgentId (same value)
  // The server still accepts `manager` (name) at the API boundary.
  const agentBody: Record<string, unknown> = { ...body };
  if (typeof agentBody.resumeSessionId === "string") {
    agentBody.resumeAgentId = agentBody.resumeSessionId;
    delete agentBody.resumeSessionId;
  }
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
    set({ status: failureStatus });
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

let previewCounter = 0;

export const useStore = create<AppState>()(
  persist(
    (set, get) => {
      // Build the initial root leaf lazily — we'll migrate from activePane in merge()
      const _initialRoot = makeRootLeaf(null);
      return {
        theme: "void",
        agentIconStyle: "provider",
        sidebarViewMode: "hierarchy",
        sidebarViewModeExplicit: false,
        activePane: null,
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
        autonomousMode: true,
        pinnedOrder: [],
        unpinnedOrder: [],
        hierarchyOrder: {},
        previewPanes: [],
        layout: _initialRoot,
        focusedLeafId: _initialRoot.id,
        groups: {},
        activeGroupId: null,

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
        toggleAutonomousMode: () =>
          set({ autonomousMode: !get().autonomousMode }),
        setStatus: (status) => set({ status }),
        switchPane: (pane) => {
          if (!pane) {
            set({ activePane: null });
            return;
          }
          const { layout, focusedLeafId, groups, activeGroupId } = get();

          // Case 1: pane is in the currently active group — just focus it
          if (
            activeGroupId &&
            groups[activeGroupId]?.memberPaneIds.includes(pane.id)
          ) {
            const leaf = findLeafByPaneId(layout, pane.id);
            if (leaf) {
              // Activate the tab containing this pane
              const tabIdx = leaf.tabs.findIndex((t) => t.pane.id === pane.id);
              const updatedLayout =
                tabIdx >= 0 ? setActiveTab(layout, leaf.id, tabIdx) : layout;
              set({
                layout: updatedLayout,
                focusedLeafId: leaf.id,
                activePane: pane,
              });
              return;
            }
            // Stale memberPaneIds — pane listed but not in layout tree. Clean it up.
            const group = groups[activeGroupId];
            const cleaned = group.memberPaneIds.filter((id) => id !== pane.id);
            set({
              groups: {
                ...groups,
                [activeGroupId]: { ...group, memberPaneIds: cleaned },
              },
            });
            // Fall through to Case 2/3/4 to navigate normally
          }

          // Case 2: navigating away — save current group snapshot if active
          // Re-read groups in case stale cleanup above modified them
          const updatedGroups = { ...get().groups };
          if (activeGroupId && updatedGroups[activeGroupId]) {
            updatedGroups[activeGroupId] = {
              ...updatedGroups[activeGroupId],
              savedLayout: layout,
              savedFocusedLeafId: focusedLeafId,
            };
          }

          // Case 3: target pane belongs to another group — restore its layout
          const targetGroup = getGroupForPane(updatedGroups, pane.id);
          if (targetGroup) {
            let restoredLayout = targetGroup.savedLayout;
            const leaf = findLeafByPaneId(restoredLayout, pane.id);
            // Activate the tab containing this pane
            if (leaf) {
              const tabIdx = leaf.tabs.findIndex((t) => t.pane.id === pane.id);
              if (tabIdx >= 0) {
                restoredLayout = setActiveTab(restoredLayout, leaf.id, tabIdx);
              }
            }
            set({
              groups: updatedGroups,
              activeGroupId: targetGroup.id,
              layout: restoredLayout,
              focusedLeafId: leaf?.id ?? targetGroup.savedFocusedLeafId,
              activePane: pane,
            });
            return;
          }

          // Case 4: ungrouped pane — single-pane view
          const rootLeaf = makeRootLeaf(pane);
          set({
            groups: updatedGroups,
            activeGroupId: null,
            layout: rootLeaf,
            focusedLeafId: rootLeaf.id,
            activePane: pane,
          });
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
            // entries don't accumulate for users who never reorder/pin. Preview
            // keys are kept (previews live in unpinnedOrder too). Reorder/pin/
            // unpin also re-freeze, so this only matters between interactions.
            const live = new Set<string>(sessions.map(sessionOrderKey));
            const keepKey = (k: string) =>
              k.startsWith("preview:") || live.has(k);
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

            const { activePane } = get();
            if (
              activePane?.type === "session" &&
              !sessions.some((s) => s.id === activePane.id)
            ) {
              set({ activePane: null, status: "disconnected" });
            }
          } else if (!get().sessionsInitialFetchDone) {
            // No change in session arrays (both empty) but this was the
            // first successful fetch — flip the flag so App.tsx can act
            // (e.g. auto-open the Create Agent panel for first-run UX).
            set({ sessionsInitialFetchDone: true });
          }

          // Prune layout tabs referencing sessions that no longer exist.
          // Runs even when session list is unchanged — layout may have stale
          // tabs from localStorage persisted across page reloads.
          const validIds = new Set(sessions.map((s) => s.id));
          const { layout, focusedLeafId, groups, activeGroupId } = get();
          const pruned = pruneStaleSessionTabs(layout, validIds);
          if (pruned && pruned !== layout) {
            const newFocused = findLeaf(pruned, focusedLeafId)
              ? focusedLeafId
              : nextLeafId(pruned, focusedLeafId);
            const newActive = derivedActivePane(pruned, newFocused);
            const groupUpdates = syncGroupAfterRemoval(
              groups,
              activeGroupId,
              pruned,
              newFocused,
            );
            set({
              layout: pruned,
              focusedLeafId: newFocused,
              activePane: newActive,
              ...groupUpdates,
            });
          } else if (!pruned) {
            // All tabs were stale — reset to empty root
            const root = makeRootLeaf(null);
            set({
              layout: root,
              focusedLeafId: root.id,
              activePane: null,
              groups: {},
              activeGroupId: null,
            });
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
              autonomousMode: opts?.autonomousMode ?? get().autonomousMode,
              name: opts?.name,
              provider: opts?.provider,
              template: opts?.template,
              appendSystemPrompt: opts?.appendSystemPrompt,
            },
          );
        },

        openCreateAgent: () => {
          const { layout, focusedLeafId } = get();
          const pane: ActivePane = {
            type: "create-agent",
            id: "create-agent",
          };
          if (findLeafByPaneId(layout, "create-agent")) {
            get().switchPane(pane);
            return;
          }
          set({
            activePane: pane,
            layout: addTab(layout, focusedLeafId, pane),
          });
        },
        resumeSession: async (claudeSessionId, cwd, name, opts) => {
          const existing = get().sessions.find(
            (s) => s.claudeSessionId === claudeSessionId,
          );
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
            const resumed = get().sessions.find(
              (s) => s.claudeSessionId === claudeSessionId,
            );
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
                const retry = get().sessions.find(
                  (s) => s.claudeSessionId === claudeSessionId,
                );
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

          await spawnSession(
            set,
            get,
            "resuming...",
            "failed to resume session",
            {
              workingDirectory: cwd,
              resumeSessionId: claudeSessionId,
              name,
              autonomousMode: get().autonomousMode,
            },
          );
        },
        killSession: async (id) => {
          await fetch(`/api/agents/${id}/kill`, { method: "POST" }).catch(
            () => null,
          );
          const { activePane } = get();
          if (activePane?.type === "session" && activePane.id === id) {
            set({ activePane: null, status: "disconnected" });
          }
          await get().fetchSessions();
        },
        openPreview: (filePath) => {
          const { previewPanes } = get();
          // If already open, switch to it (find its leaf + tab)
          const existing = previewPanes.find((p) => p.filePath === filePath);
          if (existing) {
            get().switchPane({ type: "preview", id: existing.id });
            return;
          }
          const id = `preview-${Date.now()}-${++previewCounter}`;
          const title = filePath.split("/").pop() || filePath;
          const pane: PreviewPaneInfo = { id, filePath, title };
          const { unpinnedOrder, layout, focusedLeafId } = get();
          const activeP: ActivePane = { type: "preview", id };
          // Add preview as a new tab in the focused leaf. A new preview is a
          // fresh arrival → top of the unpinned section.
          set({
            previewPanes: [...previewPanes, pane],
            unpinnedOrder: [previewOrderKey(id), ...unpinnedOrder],
            activePane: activeP,
            layout: addTab(layout, focusedLeafId, activeP),
          });
        },

        openOrgChart: () => {
          const { layout, focusedLeafId } = get();
          const orgPane: ActivePane = { type: "orgchart", id: "orgchart" };
          // If orgchart tab already exists anywhere, just switch to it
          if (findLeafByPaneId(layout, "orgchart")) {
            get().switchPane(orgPane);
            return;
          }
          set({
            activePane: orgPane,
            layout: addTab(layout, focusedLeafId, orgPane),
          });
        },

        openTemplates: () => {
          const { layout, focusedLeafId } = get();
          const pane: ActivePane = { type: "templates", id: "templates" };
          if (findLeafByPaneId(layout, "templates")) {
            get().switchPane(pane);
            return;
          }
          set({
            activePane: pane,
            layout: addTab(layout, focusedLeafId, pane),
          });
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
          const { layout, focusedLeafId } = get();
          const pane: ActivePane = { type: "schedules", id: "schedules" };
          if (findLeafByPaneId(layout, "schedules")) {
            get().switchPane(pane);
            return;
          }
          set({
            activePane: pane,
            layout: addTab(layout, focusedLeafId, pane),
          });
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

        closePreview: (id) => {
          const {
            previewPanes,
            pinnedOrder,
            unpinnedOrder,
            activePane,
            sessions,
            layout,
            focusedLeafId,
            groups,
            activeGroupId,
          } = get();
          const previewKey = previewOrderKey(id);
          const updated: Partial<AppState> = {
            previewPanes: previewPanes.filter((p) => p.id !== id),
            pinnedOrder: pinnedOrder.filter((k) => k !== previewKey),
            unpinnedOrder: unpinnedOrder.filter((k) => k !== previewKey),
          };

          // Find the leaf holding this preview in the layout
          const previewLeaf = findLeafByPaneId(layout, id);

          if (previewLeaf) {
            // Try to remove the leaf from the layout (split pane case)
            const collapsed = removeLeaf(layout, previewLeaf.id);
            if (collapsed) {
              // Split pane: sibling expands to fill the space
              const newFocused =
                focusedLeafId === previewLeaf.id
                  ? nextLeafId(collapsed, previewLeaf.id)
                  : focusedLeafId;
              updated.layout = collapsed;
              updated.focusedLeafId = newFocused;
              updated.activePane = derivedActivePane(collapsed, newFocused);

              // Sync group if active
              const groupUpdates = syncGroupAfterRemoval(
                groups,
                activeGroupId,
                collapsed,
                newFocused,
              );
              Object.assign(updated, groupUpdates);
            } else {
              // Single leaf (dedicated tab): switch to last session
              const fallbackSession = sessions.length > 0 ? sessions[0] : null;
              if (fallbackSession) {
                const pane: ActivePane = {
                  type: "session",
                  id: fallbackSession.id,
                };
                const rootLeaf = makeRootLeaf(pane);
                updated.layout = rootLeaf;
                updated.focusedLeafId = rootLeaf.id;
                updated.activePane = pane;
                updated.activeGroupId = null;
              } else {
                const rootLeaf = makeRootLeaf(null);
                updated.layout = rootLeaf;
                updated.focusedLeafId = rootLeaf.id;
                updated.activePane = null;
              }
            }
          } else if (activePane?.type === "preview" && activePane.id === id) {
            // Preview wasn't in layout but was active — fall back to a session
            if (sessions.length > 0) {
              updated.activePane = {
                type: "session",
                id: sessions[0].id,
              };
            } else {
              updated.activePane = null;
            }
          }

          set(updated);
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

        // ── Layout / split-pane actions ──────────────────────────────────────

        splitLeafWithPane: (leafId, direction, newSide, pane) => {
          const { layout, groups, activeGroupId } = get();
          const { root, newLeafId: newId } = insertLeaf(
            layout,
            leafId,
            direction,
            newSide,
            pane,
          );

          const groupUpdates = pane
            ? addPaneToGroup(
                groups,
                activeGroupId,
                allTabPanes(layout),
                pane.id,
                root,
                newId,
              )
            : { groups, activeGroupId };

          set({
            layout: root,
            focusedLeafId: newId,
            groups: groupUpdates.groups,
            activeGroupId: groupUpdates.activeGroupId,
          });
          if (pane) set({ activePane: pane, status: "connected" });
        },

        createSessionIntoLeaf: async (
          leafId,
          direction,
          newSide,
          cwd = "~",
        ) => {
          const { layout } = get();
          const existingPanes = allTabPanes(layout);
          // Reserve a slot by inserting a null-pane leaf first (shows loading state)
          const { root: reservedRoot, newLeafId: newId } = insertLeaf(
            layout,
            leafId,
            direction,
            newSide,
            null,
          );
          set({ layout: reservedRoot, focusedLeafId: newId });

          await spawnSession(
            set,
            get,
            "spawning...",
            "failed to create session",
            { workingDirectory: cwd, autonomousMode: get().autonomousMode },
            (session) => {
              const pane: ActivePane = { type: "session", id: session.id };
              const updatedLayout = setLeafPane(get().layout, newId, pane);
              const groupUpdates = addPaneToGroup(
                get().groups,
                get().activeGroupId,
                existingPanes,
                pane.id,
                updatedLayout,
                newId,
              );

              set({
                layout: updatedLayout,
                activePane: pane,
                status: "connected",
                groups: groupUpdates.groups,
                activeGroupId: groupUpdates.activeGroupId,
              });
            },
          );
        },

        setLeafPane: (leafId, pane) => {
          const { layout, activeGroupId, groups } = get();
          const updated = setLeafPane(layout, leafId, pane);
          set({
            layout: updated,
            focusedLeafId: leafId,
            ...(pane && { activePane: pane }),
            ...saveGroupSnapshot(groups, activeGroupId, updated, leafId),
          });
        },

        addTabToLeaf: (leafId, pane) => {
          const { layout, activeGroupId, groups } = get();
          const updated = addTab(layout, leafId, pane);
          set({
            layout: updated,
            focusedLeafId: leafId,
            activePane: pane,
            ...saveGroupSnapshot(groups, activeGroupId, updated, leafId),
          });
        },

        closeTab: (leafId, tabId) => {
          const { layout, focusedLeafId, activeGroupId, groups } = get();
          const leaf = findLeaf(layout, leafId);
          if (!leaf) return;
          // Defensive guard for stale tabIds (cached event handlers, races
          // with WS-driven tab removals, missed remap entries from
          // RestartAllButton). Without this, the empty-leaf fall-through
          // below would call removeTab with a non-existent tabId — which
          // returns the layout unchanged AND we'd still write a no-op
          // set(), producing the same "X click does nothing" UX the
          // fix above was meant to eliminate. Warn so the cause shows
          // up in dev console.
          if (!leaf.tabs.some((t) => t.id === tabId)) {
            console.warn(
              `[layout] closeTab: tabId "${tabId}" not found in leaf "${leafId}" — ignoring stale call`,
            );
            return;
          }

          // Last tab in this leaf — try to collapse the leaf so a sibling
          // takes its place. If this IS the only leaf, removeLeaf returns
          // null (the layout invariant requires at least one leaf), and
          // we deliberately fall through to removeTab below — that produces
          // an empty leaf which renders as the "Create or select an agent"
          // placeholder. Without the fall-through, the X click would
          // silently no-op when only one tab is open.
          if (leaf.tabs.length <= 1) {
            const newRoot = removeLeaf(layout, leafId);
            if (newRoot) {
              const newFocused =
                focusedLeafId === leafId
                  ? nextLeafId(newRoot, leafId)
                  : focusedLeafId;
              const groupUpdates = syncGroupAfterRemoval(
                groups,
                activeGroupId,
                newRoot,
                newFocused,
              );
              set({
                layout: newRoot,
                focusedLeafId: newFocused,
                activePane: derivedActivePane(newRoot, newFocused),
                ...groupUpdates,
              });
              return;
            }
            // Fall through: only leaf in tree → empty its tabs.
          }

          const updated = removeTab(layout, leafId, tabId);
          const newActivePane = derivedActivePane(updated, focusedLeafId);
          set({
            layout: updated,
            activePane: newActivePane,
            ...saveGroupSnapshot(groups, activeGroupId, updated, focusedLeafId),
          });
        },

        switchTabInLeaf: (leafId, tabIndex) => {
          const { layout, activeGroupId, groups } = get();
          const updated = setActiveTab(layout, leafId, tabIndex);
          const leaf = findLeaf(updated, leafId);
          const pane = leaf ? activeTabPane(leaf) : null;
          set({
            layout: updated,
            focusedLeafId: leafId,
            ...(pane && { activePane: pane }),
            ...saveGroupSnapshot(groups, activeGroupId, updated, leafId),
          });
        },

        setLeafSizes: (branchId, sizes) => {
          const { layout, activeGroupId, groups, focusedLeafId } = get();
          const updatedLayout = updateBranchSizes(layout, branchId, sizes);
          set({
            layout: updatedLayout,
            ...saveGroupSnapshot(
              groups,
              activeGroupId,
              updatedLayout,
              focusedLeafId,
            ),
          });
        },

        setFocusedLeaf: (leafId) => {
          const { layout } = get();
          set({
            focusedLeafId: leafId,
            activePane: derivedActivePane(layout, leafId),
          });
        },

        closeLeaf: (leafId) => {
          const { layout, focusedLeafId, groups, activeGroupId } = get();
          const newRoot = removeLeaf(layout, leafId);
          if (!newRoot) return; // Don't remove the last leaf

          const newFocused =
            focusedLeafId === leafId
              ? nextLeafId(newRoot, leafId)
              : focusedLeafId;

          const groupUpdates = syncGroupAfterRemoval(
            groups,
            activeGroupId,
            newRoot,
            newFocused,
          );

          set({
            layout: newRoot,
            focusedLeafId: newFocused,
            activePane: derivedActivePane(newRoot, newFocused),
            ...groupUpdates,
          });
        },

        movePaneToLeaf: (paneId, targetLeafId, zone) => {
          const { layout, activeGroupId, groups } = get();
          // Search all tabs for the pane
          const pane = allTabPanes(layout).find((p) => p.id === paneId);
          if (!pane) return;

          const sourceLeaf = findLeafByPaneId(layout, paneId);
          if (!sourceLeaf) return;

          // Don't drop on yourself (center = no-op, directional with single tab = no-op)
          if (sourceLeaf.id === targetLeafId) {
            if (zone === "center") return;
            if (sourceLeaf.tabs.length <= 1) return;
          }

          // Find the tab ID for removal from source
          const sourceTab = sourceLeaf.tabs.find((t) => t.pane.id === paneId);

          let result: LayoutNode;
          let focusLeafId: string;

          if (zone === "center") {
            // Add as tab in target
            const updated = addTab(layout, targetLeafId, pane);
            // Remove from source: if source had multiple tabs, just remove the tab
            // If source had only one tab, remove the whole leaf
            if (sourceLeaf.tabs.length <= 1) {
              const cleaned = removeLeaf(updated, sourceLeaf.id);
              result = cleaned ?? updated;
            } else if (sourceTab) {
              result = removeTab(updated, sourceLeaf.id, sourceTab.id);
            } else {
              result = updated;
            }
            focusLeafId = targetLeafId;
          } else {
            // Directional: split target, then remove source tab/leaf
            const directionMap = {
              north: ["vertical", "first"],
              south: ["vertical", "second"],
              west: ["horizontal", "first"],
              east: ["horizontal", "second"],
            } as const;
            const [dir, side] = directionMap[zone];
            const { root: split, newLeafId: newId } = insertLeaf(
              layout,
              targetLeafId,
              dir,
              side,
              pane,
            );
            // If source had multiple tabs, only remove the dragged tab
            if (sourceLeaf.tabs.length <= 1) {
              const cleaned = removeLeaf(split, sourceLeaf.id);
              result = cleaned ?? split;
            } else if (sourceTab) {
              result = removeTab(split, sourceLeaf.id, sourceTab.id);
            } else {
              result = split;
            }
            focusLeafId = newId;
          }

          const groupUpdates = syncGroupAfterRemoval(
            groups,
            activeGroupId,
            result,
            focusLeafId,
          );

          set({
            layout: result,
            focusedLeafId: focusLeafId,
            activePane: pane,
            ...groupUpdates,
          });
        },

        remapSessionIds: (idMap) => {
          const {
            layout,
            activePane,
            pinnedOrder,
            unpinnedOrder,
            groups,
            activeGroupId,
          } = get();

          // Helper: remap a pane reference
          const remapPane = (p: ActivePane | null): ActivePane | null => {
            if (!p || p.type !== "session") return p;
            const newId = idMap[p.id];
            return newId ? { ...p, id: newId } : p;
          };

          // Remap layout tree panes (including all tabs)
          const remapLayout = (node: LayoutNode): LayoutNode => {
            if (node.kind === "leaf") {
              return {
                ...node,
                tabs: node.tabs.map((t) => ({
                  ...t,
                  pane: remapPane(t.pane) ?? t.pane,
                })),
              };
            }
            return {
              ...node,
              first: remapLayout(node.first),
              second: remapLayout(node.second),
            };
          };

          // Remap both flat-view order arrays — keys are raw claudeSessionId or
          // internal id (no prefix). claudeSessionId doesn't change on restart,
          // so only entries that used the internal id need remapping.
          const remapKey = (key: string) => {
            if (key.startsWith("preview:")) return key;
            return idMap[key] ?? key;
          };

          // Remap groups
          const newGroups: Record<string, PaneGroup> = {};
          for (const [gid, g] of Object.entries(groups)) {
            newGroups[gid] = {
              ...g,
              memberPaneIds: g.memberPaneIds.map((id) => idMap[id] ?? id),
              savedLayout: remapLayout(g.savedLayout),
            };
          }

          set({
            layout: remapLayout(layout),
            activePane: remapPane(activePane),
            pinnedOrder: pinnedOrder.map(remapKey),
            unpinnedOrder: unpinnedOrder.map(remapKey),
            groups: newGroups,
            activeGroupId,
          });

          // Fetch new session list
          get().fetchSessions();
        },

        removeFromGroup: (groupId, paneId) => {
          const { groups, activeGroupId, layout, focusedLeafId } = get();
          const group = groups[groupId];
          if (!group) return;

          const updatedGroups = { ...groups };
          const remaining = group.memberPaneIds.filter((id) => id !== paneId);

          if (remaining.length <= 1) {
            // Group dissolves
            delete updatedGroups[groupId];
            set({
              groups: updatedGroups,
              activeGroupId: activeGroupId === groupId ? null : activeGroupId,
            });
          } else {
            // Remove pane from group, update saved layout
            const leaf = findLeafByPaneId(layout, paneId);
            let updatedLayout = layout;
            let updatedFocused = focusedLeafId;
            if (leaf && activeGroupId === groupId) {
              // Remove the pane's leaf from the layout if we're viewing this group
              const cleaned = removeLeaf(layout, leaf.id);
              if (cleaned) {
                updatedLayout = cleaned;
                updatedFocused =
                  focusedLeafId === leaf.id
                    ? nextLeafId(cleaned, leaf.id)
                    : focusedLeafId;
              }
            }
            updatedGroups[groupId] = {
              ...group,
              memberPaneIds: remaining,
              savedLayout: updatedLayout,
              savedFocusedLeafId: updatedFocused,
            };
            set({
              groups: updatedGroups,
              layout: updatedLayout,
              focusedLeafId: updatedFocused,
              activePane: derivedActivePane(updatedLayout, updatedFocused),
            });
          }
        },
      };
    },
    {
      name: "autonomos",
      partialize: (state) => ({
        theme: state.theme,
        agentIconStyle: state.agentIconStyle,
        sidebarViewMode: state.sidebarViewMode,
        sidebarViewModeExplicit: state.sidebarViewModeExplicit,
        activePane: state.activePane,
        sidebarOpen: state.sidebarOpen,
        sidebarWidth: state.sidebarWidth,
        autonomousMode: state.autonomousMode,
        pinnedOrder: state.pinnedOrder,
        unpinnedOrder: state.unpinnedOrder,
        hierarchyOrder: state.hierarchyOrder,
        previewPanes: state.previewPanes,
        layout: state.layout,
        focusedLeafId: state.focusedLeafId,
        groups: state.groups,
        activeGroupId: state.activeGroupId,
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
        if (typeof saved?.autonomousMode === "boolean")
          merged.autonomousMode = saved.autonomousMode;
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
        if (Array.isArray(saved?.previewPanes))
          merged.previewPanes = saved.previewPanes as PreviewPaneInfo[];

        // Migrate old sessionId → activePane
        if (saved?.activePane && typeof saved.activePane === "object") {
          merged.activePane = saved.activePane as ActivePane;
        } else if (typeof saved?.sessionId === "string") {
          merged.activePane = { type: "session", id: saved.sessionId };
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

        // Migrate: if layout is missing, construct from existing activePane.
        // Also migrate old single-pane leaves to tabs format.
        try {
          if (
            saved?.layout &&
            typeof saved.layout === "object" &&
            (saved.layout as LayoutNode).kind
          ) {
            merged.layout = migrateLayout(saved.layout);
            if (typeof saved.focusedLeafId === "string") {
              merged.focusedLeafId = saved.focusedLeafId;
            }
          } else {
            const rootLeaf = makeRootLeaf(merged.activePane);
            merged.layout = rootLeaf;
            merged.focusedLeafId = rootLeaf.id;
          }
        } catch (err) {
          console.error("[autonomOS] Failed to migrate layout:", err);
          const rootLeaf = makeRootLeaf(merged.activePane);
          merged.layout = rootLeaf;
          merged.focusedLeafId = rootLeaf.id;
        }

        // Restore groups — validate each entry has required fields
        if (
          saved?.groups &&
          typeof saved.groups === "object" &&
          !Array.isArray(saved.groups)
        ) {
          try {
            const validGroups: Record<string, PaneGroup> = {};
            for (const [gid, g] of Object.entries(
              saved.groups as Record<string, unknown>,
            )) {
              const group = g as Record<string, unknown>;
              if (
                group &&
                typeof group.id === "string" &&
                Array.isArray(group.memberPaneIds) &&
                group.savedLayout &&
                typeof (group.savedLayout as LayoutNode).kind === "string"
              ) {
                const migrated = {
                  ...(group as unknown as PaneGroup),
                  savedLayout: migrateLayout(group.savedLayout),
                };
                validGroups[gid] = migrated;
              }
            }
            merged.groups = validGroups;
          } catch (err) {
            console.error("[autonomOS] Failed to migrate groups:", err);
            merged.groups = {};
            merged.activeGroupId = null;
          }
        }
        if (typeof saved?.activeGroupId === "string") {
          merged.activeGroupId = saved.activeGroupId;
        }

        if (Array.isArray(saved?.projects)) {
          merged.projects = saved.projects as ProjectInfo[];
        }

        return merged;
      },
    },
  ),
);
