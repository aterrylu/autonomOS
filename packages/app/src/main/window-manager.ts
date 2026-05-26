// Multi-window BrowserWindow lifecycle.
//
// ADR-029 (Built-in / Always-on server): the first window opened at app
// launch represents the "This Mac" connection — managed by the server-
// supervisor. Welcome windows (for adding remote connections) remain.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  screen,
} from "electron";

import { setConfig } from "./config/store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const windowsByConnectionId = new Map<string, BrowserWindow>();
const welcomeWindows = new Set<BrowserWindow>();
let splashWindow: BrowserWindow | null = null;

// ── Manual window drag state ────────────────────────────────────────

interface DragState {
  offsetX: number;
  offsetY: number;
  interval: NodeJS.Timeout;
}
const drags = new Map<number, DragState>();

export function startDrag(win: BrowserWindow): void {
  endDrag(win.id);
  const cursor = screen.getCursorScreenPoint();
  const pos = win.getPosition();
  const winX = pos[0] ?? 0;
  const winY = pos[1] ?? 0;
  const offsetX = cursor.x - winX;
  const offsetY = cursor.y - winY;
  const interval = setInterval(() => {
    if (win.isDestroyed()) {
      endDrag(win.id);
      return;
    }
    const c = screen.getCursorScreenPoint();
    win.setPosition(c.x - offsetX, c.y - offsetY, false);
  }, 8);
  drags.set(win.id, { offsetX, offsetY, interval });
}

export function endDrag(winId: number): void {
  const state = drags.get(winId);
  if (!state) return;
  clearInterval(state.interval);
  drags.delete(winId);
}

export function cleanupAllDrags(): void {
  for (const state of drags.values()) clearInterval(state.interval);
  drags.clear();
}

// ── BrowserWindow factory ───────────────────────────────────────────

function macWindowOptions(): Partial<BrowserWindowConstructorOptions> {
  if (process.platform !== "darwin") return {};
  return { titleBarStyle: "hiddenInset", vibrancy: "sidebar" };
}

function makeBrowserWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0e14",
    show: false,
    ...macWindowOptions(),
    webPreferences: {
      preload: resolve(__dirname, "../preload/main.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
}

function rendererHtmlPath(): string {
  return resolve(__dirname, "../renderer/index.html");
}

// ── Splash ──────────────────────────────────────────────────────────

export function openSplashWindow(): BrowserWindow {
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;
  splashWindow = new BrowserWindow({
    width: 480,
    height: 320,
    backgroundColor: "#0a0e14",
    frame: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    show: false,
    webPreferences: {
      preload: resolve(__dirname, "../preload/main.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  splashWindow.loadFile(rendererHtmlPath(), { hash: "splash" });
  splashWindow.once("ready-to-show", () => splashWindow?.show());
  splashWindow.on("closed", () => {
    splashWindow = null;
  });
  return splashWindow;
}

export function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
}

// ── Welcome / Connection windows ────────────────────────────────────

export function openWelcomeWindow(): BrowserWindow {
  const window = makeBrowserWindow();
  welcomeWindows.add(window);
  window.loadFile(rendererHtmlPath());
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    welcomeWindows.delete(window);
    endDrag(window.id);
  });
  return window;
}

export function openConnectionWindow(connectionId: string): BrowserWindow {
  const existing = windowsByConnectionId.get(connectionId);
  if (existing) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  const window = makeBrowserWindow();
  windowsByConnectionId.set(connectionId, window);
  window.loadFile(rendererHtmlPath(), { hash: connectionId });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    windowsByConnectionId.delete(connectionId);
    endDrag(window.id);
    void persistOpenWindows();
  });
  void persistOpenWindows();
  return window;
}

export function hasAnyWindow(): boolean {
  return (
    windowsByConnectionId.size > 0 ||
    welcomeWindows.size > 0 ||
    splashWindow !== null
  );
}

export function getConnectionWindow(id: string): BrowserWindow | undefined {
  return windowsByConnectionId.get(id);
}

async function persistOpenWindows(): Promise<void> {
  const ids = Array.from(windowsByConnectionId.keys());
  await setConfig((current) => ({ ...current, openWindows: ids }));
}

export async function restoreOpenWindows(): Promise<void> {
  const { getConfig } = await import("./config/store.js");
  const config = await getConfig();
  const ids = config.openWindows ?? [];
  let restored = 0;
  for (const id of ids) {
    if (id === "local" || config.connections.some((c) => c.id === id)) {
      openConnectionWindow(id);
      restored++;
    }
  }
  if (restored === 0) openConnectionWindow("local");
}
