import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  activePane: ActivePane | null;
  sidebarOpen: boolean;
  autonomousMode: boolean;
  paneOrder: string[];
  previewPanes: PreviewPaneInfo[];

  // Transient
  status: string;
  sessions: SessionInfo[];
  projects: ProjectInfo[];

  // Actions
  cycleTheme: () => void;
  toggleSidebar: () => void;
  toggleAutonomousMode: () => void;
  setStatus: (status: string) => void;
  switchPane: (pane: ActivePane | null) => void;
  fetchSessions: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  createSession: (workingDirectory?: string) => Promise<void>;
  resumeSession: (
    claudeSessionId: string,
    cwd: string,
    name?: string,
  ) => Promise<void>;
  killSession: (id: string) => Promise<void>;
  openPreview: (filePath: string) => void;
  closePreview: (id: string) => void;
  reorderPanes: (fromIndex: number, toIndex: number) => void;
}

type SetState = (partial: Partial<AppState>) => void;
type GetState = () => AppState;

/**
 * Shared logic for createSession and resumeSession.
 * Guards against concurrent spawns and handles fetch errors uniformly.
 */
async function spawnSession(
  set: SetState,
  get: GetState,
  pendingStatus: string,
  failureStatus: string,
  body: Record<string, unknown>,
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
  set({
    activePane: { type: "session", id: session.id },
    status: "connected",
  });
  await get().fetchSessions();
}

let previewCounter = 0;

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      theme: "midnight",
      activePane: null,
      status: "disconnected",
      sessions: [],
      projects: [],
      sidebarOpen: true,
      autonomousMode: true,
      paneOrder: [],
      previewPanes: [],

      cycleTheme: () => {
        const current = get().theme;
        const next =
          THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
        set({ theme: next });
      },
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
      toggleAutonomousMode: () =>
        set({ autonomousMode: !get().autonomousMode }),
      setStatus: (status) => set({ status }),
      switchPane: (pane) => set({ activePane: pane }),

      fetchSessions: async () => {
        const res = await fetch("/api/sessions").catch(() => null);
        if (!res?.ok) return;
        const sessions: SessionInfo[] = await res.json();
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
      resumeSession: async (claudeSessionId, cwd, name) => {
        const existing = get().sessions.find(
          (s) => s.claudeSessionId === claudeSessionId,
        );
        if (existing) {
          set({
            activePane: { type: "session", id: existing.id },
            status: "connected",
          });
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
        // If already open, just switch to it
        const existing = previewPanes.find((p) => p.filePath === filePath);
        if (existing) {
          set({ activePane: { type: "preview", id: existing.id } });
          return;
        }
        const id = `preview-${Date.now()}-${++previewCounter}`;
        const title = filePath.split("/").pop() || filePath;
        const pane: PreviewPaneInfo = { id, filePath, title };
        const { paneOrder } = get();
        set({
          previewPanes: [...previewPanes, pane],
          paneOrder: [...paneOrder, previewOrderKey(id)],
          activePane: { type: "preview", id },
        });
      },

      closePreview: (id) => {
        const { previewPanes, paneOrder, activePane, sessions } = get();
        const updated: Partial<AppState> = {
          previewPanes: previewPanes.filter((p) => p.id !== id),
          paneOrder: paneOrder.filter((k) => k !== previewOrderKey(id)),
        };
        // If closing the active pane, fall back to first session or null
        if (activePane?.type === "preview" && activePane.id === id) {
          if (sessions.length > 0) {
            updated.activePane = { type: "session", id: sessions[0].id };
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
    }),
    {
      name: "autonomos",
      partialize: (state) => ({
        theme: state.theme,
        activePane: state.activePane,
        sidebarOpen: state.sidebarOpen,
        autonomousMode: state.autonomousMode,
        paneOrder: state.paneOrder,
        previewPanes: state.previewPanes,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Record<string, unknown>;
        const merged = { ...current };

        if (isThemeName(saved?.theme)) merged.theme = saved.theme;
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

        return merged;
      },
    },
  ),
);
