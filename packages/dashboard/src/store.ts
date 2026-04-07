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
  allTabPanes,
  derivedActivePane,
  findLeaf,
  findLeafByPaneId,
  insertLeaf,
  type LayoutNode,
  makeRootLeaf,
  migrateLayout,
  nextLeafId,
  removeLeaf,
  removeTab,
  type SplitDirection,
  type SplitSide,
  setActiveTab,
  setLeafPane,
  type TabItem,
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
  claudeSessionId?: string;
  createdAt: number;
  updatedAt: number;
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
  gitDiffStat?: GitDiffStat;
  /** True if this session is managed by autonomOS */
  isAutonomosAgent?: boolean;
  /** Lifecycle status for autonomOS agents */
  autonomosStatus?: "running" | "exited";
  /** Template used to spawn this agent */
  template?: string;
}

export interface GitDiffStat {
  insertions: number;
  deletions: number;
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
  | { type: "preview"; id: string };

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
 * After removing a leaf, prune the active group's member list.
 * Dissolves the group if only 0-1 members remain.
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

    if (updatedMembers.length <= 1) {
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

function isThemeName(value: unknown): value is ThemeName {
  return typeof value === "string" && value in THEMES;
}

// ── Pane ordering helpers ──────────────────────────────────────────────

/** Key used in paneOrder for a session */
function sessionOrderKey(s: SessionInfo): string {
  return s.claudeSessionId || s.id;
}

/** Key used in paneOrder for a preview */
function previewOrderKey(id: string): string {
  return `preview:${id}`;
}

/**
 * Build a unified, ordered list of sidebar items from sessions + previews.
 * Items in paneOrder come first (in order), then remaining items at the end.
 */
export function buildSidebarItems(
  sessions: SessionInfo[],
  previews: PreviewPaneInfo[],
  paneOrder: string[],
): SidebarItem[] {
  const itemsByKey = new Map<string, SidebarItem>();
  for (const s of sessions) {
    itemsByKey.set(sessionOrderKey(s), { type: "session", data: s });
  }
  for (const p of previews) {
    itemsByKey.set(previewOrderKey(p.id), { type: "preview", data: p });
  }

  const result: SidebarItem[] = [];
  const placed = new Set<string>();

  // Place ordered items first
  for (const key of paneOrder) {
    const item = itemsByKey.get(key);
    if (item) {
      result.push(item);
      placed.add(key);
    }
  }

  // Append unordered items
  for (const [key, item] of itemsByKey) {
    if (!placed.has(key)) result.push(item);
  }

  return result;
}

/** Get the paneOrder key for a SidebarItem */
export function sidebarItemKey(item: SidebarItem): string {
  if (item.type === "session") return sessionOrderKey(item.data);
  return previewOrderKey(item.data.id);
}

/** Get the ActivePane for a SidebarItem */
export function sidebarItemPane(item: SidebarItem): ActivePane {
  return item.type === "session"
    ? { type: "session", id: item.data.id }
    : { type: "preview", id: item.data.id };
}

// ── Store ──────────────────────────────────────────────────────────────

interface AppState {
  // Persisted
  theme: ThemeName;
  viewMode: "terminal" | "conversation" | "hierarchy";
  activePane: ActivePane | null;
  sidebarOpen: boolean;
  autonomousMode: boolean;
  paneOrder: string[];
  previewPanes: PreviewPaneInfo[];
  layout: LayoutNode;
  focusedLeafId: string;
  groups: Record<string, PaneGroup>;
  activeGroupId: string | null;

  // Transient
  status: string;
  sessions: SessionInfo[];
  projects: ProjectInfo[];
  /** Unread notification count per session ID */
  notificationCounts: Record<string, number>;
  /** Agent status per session ID (from hook events) */
  agentStatuses: Record<
    string,
    { status: string; currentTool?: string; toolDetail?: string }
  >;

  // Actions
  cycleTheme: () => void;
  toggleSidebar: () => void;
  toggleAutonomousMode: () => void;
  toggleViewMode: () => void;
  setViewMode: (mode: "terminal" | "conversation" | "hierarchy") => void;
  setStatus: (status: string) => void;
  switchPane: (pane: ActivePane | null) => void;
  fetchSessions: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  fetchNotifications: () => Promise<void>;
  markNotificationsRead: (sessionId: string) => Promise<void>;
  createSession: (workingDirectory?: string) => Promise<void>;
  resumeSession: (
    claudeSessionId: string,
    cwd: string,
    name?: string,
    opts?: { isAutonomosAgent?: boolean },
  ) => Promise<void>;
  killSession: (id: string) => Promise<void>;
  openPreview: (filePath: string) => void;
  closePreview: (id: string) => void;
  reorderPanes: (fromIndex: number, toIndex: number) => void;

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

  const res = await fetch("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => null);

  if (!res) {
    set({ status: "server unreachable" });
    return;
  }
  if (!res.ok) {
    set({ status: failureStatus });
    return;
  }

  const session: SessionInfo = await res.json();
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
        viewMode: "terminal",
        activePane: null,
        status: "disconnected",
        sessions: [],
        projects: [],
        notificationCounts: {},
        agentStatuses: {},
        sidebarOpen: true,
        autonomousMode: true,
        paneOrder: [],
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
        toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
        toggleAutonomousMode: () =>
          set({ autonomousMode: !get().autonomousMode }),
        toggleViewMode: () =>
          set({
            viewMode:
              get().viewMode === "terminal" ? "conversation" : "terminal",
          }),
        setViewMode: (mode) => set({ viewMode: mode }),
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
          const res = await fetch("/api/sessions").catch(() => null);
          if (!res?.ok) return;
          const allSessions: SessionInfo[] = await res.json();
          // Filter out exited sessions — they have no PTY and would create
          // broken terminals with perpetual WebSocket reconnect loops.
          const sessions = allSessions.filter((s) => s.status !== "exited");
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
          if (unchanged) return;
          set({ sessions });

          const { activePane } = get();
          if (
            activePane?.type === "session" &&
            !sessions.some((s) => s.id === activePane.id)
          ) {
            set({ activePane: null, status: "disconnected" });
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
        createSession: async (workingDirectory = "~") => {
          await spawnSession(
            set,
            get,
            "spawning...",
            "failed to create session",
            {
              workingDirectory,
              autonomousMode: get().autonomousMode,
            },
          );
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
            const res = await fetch(
              `/api/sessions/${claudeSessionId}/resume`,
              { method: "POST" },
            ).catch(() => null);
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
          await fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(
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
          const { paneOrder, layout, focusedLeafId } = get();
          const activeP: ActivePane = { type: "preview", id };
          // Add preview as a new tab in the focused leaf
          set({
            previewPanes: [...previewPanes, pane],
            paneOrder: [...paneOrder, previewOrderKey(id)],
            activePane: activeP,
            layout: addTab(layout, focusedLeafId, activeP),
          });
        },

        closePreview: (id) => {
          const {
            previewPanes,
            paneOrder,
            activePane,
            sessions,
            layout,
            focusedLeafId,
            groups,
            activeGroupId,
          } = get();
          const updated: Partial<AppState> = {
            previewPanes: previewPanes.filter((p) => p.id !== id),
            paneOrder: paneOrder.filter((k) => k !== previewOrderKey(id)),
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

        reorderPanes: (fromIndex, toIndex) => {
          const { sessions, previewPanes, paneOrder } = get();
          const items = buildSidebarItems(sessions, previewPanes, paneOrder);
          const ordered = items.map(sidebarItemKey);
          const [moved] = ordered.splice(fromIndex, 1);
          ordered.splice(toIndex, 0, moved);
          set({ paneOrder: ordered });
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

          // If this is the last tab, close the leaf entirely
          if (leaf.tabs.length <= 1) {
            get().closeLeaf(leafId);
            return;
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
          const { layout, activePane, paneOrder, groups, activeGroupId } =
            get();

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

          // Remap paneOrder — keys are raw claudeSessionId or internal id
          // (no prefix). claudeSessionId doesn't change on restart, so only
          // entries that used the internal id need remapping.
          const newPaneOrder = paneOrder.map((key) => {
            if (key.startsWith("preview:")) return key;
            const newId = idMap[key];
            return newId ?? key;
          });

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
            paneOrder: newPaneOrder,
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
        viewMode: state.viewMode,
        activePane: state.activePane,
        sidebarOpen: state.sidebarOpen,
        autonomousMode: state.autonomousMode,
        paneOrder: state.paneOrder,
        previewPanes: state.previewPanes,
        layout: state.layout,
        focusedLeafId: state.focusedLeafId,
        groups: state.groups,
        activeGroupId: state.activeGroupId,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Record<string, unknown>;
        const merged = { ...current };

        if (isThemeName(saved?.theme)) merged.theme = saved.theme;
        // Restore viewMode but never persist "hierarchy" — it's a transient view
        if (
          saved?.viewMode === "terminal" ||
          saved?.viewMode === "conversation"
        )
          merged.viewMode = saved.viewMode;
        if (typeof saved?.sidebarOpen === "boolean")
          merged.sidebarOpen = saved.sidebarOpen;
        if (typeof saved?.autonomousMode === "boolean")
          merged.autonomousMode = saved.autonomousMode;
        if (Array.isArray(saved?.previewPanes))
          merged.previewPanes = saved.previewPanes as PreviewPaneInfo[];

        // Migrate old sessionId → activePane
        if (saved?.activePane && typeof saved.activePane === "object") {
          merged.activePane = saved.activePane as ActivePane;
        } else if (typeof saved?.sessionId === "string") {
          merged.activePane = { type: "session", id: saved.sessionId };
        }

        // Migrate old sessionOrder → paneOrder
        if (Array.isArray(saved?.paneOrder)) {
          merged.paneOrder = saved.paneOrder as string[];
        } else if (Array.isArray(saved?.sessionOrder)) {
          merged.paneOrder = saved.sessionOrder as string[];
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

        return merged;
      },
    },
  ),
);
