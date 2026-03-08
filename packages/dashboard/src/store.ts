import { create } from "zustand";

export type ThemeName = "midnight" | "daylight" | "void";

interface AppTheme {
  terminal: Record<string, string>;
  page: { bg: string; fg: string; border: string; statusFg: string };
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

function isThemeName(value: string | null): value is ThemeName {
  return value !== null && value in THEMES;
}

function loadTheme(): ThemeName {
  const stored = localStorage.getItem("theme");
  return isThemeName(stored) ? stored : "midnight";
}

interface AppState {
  theme: ThemeName;
  status: string;
  sessionId: string | null;
  cycleTheme: () => void;
  setStatus: (status: string) => void;
  setSessionId: (id: string | null) => void;
}

export const useStore = create<AppState>((set, get) => ({
  theme: loadTheme(),
  status: "disconnected",
  sessionId: null,
  cycleTheme: () => {
    const current = get().theme;
    const next =
      THEME_ORDER[(THEME_ORDER.indexOf(current) + 1) % THEME_ORDER.length];
    localStorage.setItem("theme", next);
    set({ theme: next });
  },
  setStatus: (status) => set({ status }),
  setSessionId: (sessionId) => set({ sessionId }),
}));
