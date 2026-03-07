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
