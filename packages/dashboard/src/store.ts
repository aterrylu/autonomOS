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
      foreground: "#c9d1d9",
      cursor: "#00ff9f",
      selectionBackground: "#1a3a2a",
      black: "#0d1117",
      red: "#ff6b6b",
      green: "#00ff9f",
      yellow: "#ffda6b",
      blue: "#6bc5ff",
      magenta: "#d2a8ff",
      cyan: "#76e4f7",
      white: "#f0f6fc",
    },
    page: {
      bg: "#000000",
      fg: "#c9d1d9",
      border: "#161b22",
      statusFg: "#6e7681",
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

  // Transient
  status: string;
  sessions: SessionInfo[];

  // Actions
  cycleTheme: () => void;
  setStatus: (status: string) => void;
  setSessionId: (id: string | null) => void;
  fetchSessions: () => Promise<void>;
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

      cycleTheme: () => {
        const current = get().theme;
        const next =
          THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
        set({ theme: next });
      },
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
        set({ sessionId: session.id });
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
      }),
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<AppState>),
        // Validate persisted theme
        theme: isThemeName((persisted as Partial<AppState>)?.theme)
          ? ((persisted as Partial<AppState>).theme as ThemeName)
          : current.theme,
      }),
    },
  ),
);
