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
}

/** A project directory with its Claude Code sessions */
export interface ProjectInfo {
  path: string;
  name: string;
  sessions: ProjectSession[];
  lastActive: number;
}

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

interface AppState {
  // Persisted
  theme: ThemeName;
  sessionId: string | null;
  sidebarOpen: boolean;

  // Transient
  status: string;
  sessions: SessionInfo[];
  projects: ProjectInfo[];

  // Actions
  cycleTheme: () => void;
  toggleSidebar: () => void;
  setStatus: (status: string) => void;
  setSessionId: (id: string | null) => void;
  fetchSessions: () => Promise<void>;
  fetchProjects: () => Promise<void>;
  createSession: () => Promise<void>;
  killSession: (id: string) => Promise<void>;
  switchSession: (id: string) => void;
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      theme: "midnight",
      sessionId: null,
      status: "disconnected",
      sessions: [],
      projects: [],
      sidebarOpen: true,

      cycleTheme: () => {
        const current = get().theme;
        const next =
          THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
        set({ theme: next });
      },
      toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
      setStatus: (status) => set({ status }),
      setSessionId: (id) => set({ sessionId: id }),

      fetchSessions: async () => {
        const res = await fetch("/api/sessions").catch(() => null);
        if (!res?.ok) return;
        const sessions: SessionInfo[] = await res.json();
        set({ sessions });

        const { sessionId } = get();
        if (sessionId && !sessions.some((s) => s.id === sessionId)) {
          set({ sessionId: null, status: "disconnected" });
        }
      },
      fetchProjects: async () => {
        const res = await fetch("/api/projects").catch(() => null);
        if (!res?.ok) return;
        const projects: ProjectInfo[] = await res.json();
        set({ projects });
      },
      createSession: async () => {
        if (get().status === "spawning...") return;
        set({ status: "spawning..." });

        const res = await fetch("/api/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workingDirectory: "~" }),
        }).catch(() => null);

        if (!res) {
          set({ status: "server unreachable" });
          return;
        }
        if (!res.ok) {
          set({ status: "failed to create session" });
          return;
        }

        const session: SessionInfo = await res.json();
        set({ sessionId: session.id, status: "connected" });
        await get().fetchSessions();
      },
      killSession: async (id) => {
        await fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(
          () => null,
        );
        if (get().sessionId === id) {
          set({ sessionId: null, status: "disconnected" });
        }
        await get().fetchSessions();
      },
      switchSession: (id) => set({ sessionId: id }),
    }),
    {
      name: "autonomos",
      partialize: (state) => ({
        theme: state.theme,
        sessionId: state.sessionId,
        sidebarOpen: state.sidebarOpen,
      }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<AppState>;
        return {
          ...current,
          ...saved,
          theme: isThemeName(saved?.theme) ? saved.theme : current.theme,
        };
      },
    },
  ),
);
