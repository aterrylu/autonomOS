// Multi-window BrowserWindow lifecycle. One window per connection (VS Code
// model). Welcome windows are connectionless until the user adds one.
//
// Key invariants:
//   - A connection has AT MOST one window open. Reopening focuses the
//     existing window instead of spawning a duplicate.
//   - Window state (which connections are open) persists across app quits;
//     restored on next launch via restoreOpenWindows().
//   - Welcome windows are NOT persisted — they're transient by design.
//
// Each connected window's BrowserWindow loads dist/renderer/index.html with
// a URL hash of the connection id. The renderer reads window.location.hash
// to decide whether to render the Welcome view (empty hash) or the
// ConnectionWebview (hash = connection id).

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

// ── Manual window drag state ────────────────────────────────────────
// Lifted to module scope so before-quit and window-closed handlers can
// clean up the polling intervals. Keyed by BrowserWindow.id. See
// startDrag() / endDrag() exported below.

interface DragState {
  offsetX: number;
  offsetY: number;
  interval: NodeJS.Timeout;
}
const drags = new Map<number, DragState>();

export function startDrag(win: BrowserWindow): void {
  endDrag(win.id); // belt-and-suspenders: clear any stale interval

  // Read cursor and window position TOGETHER so the offset is computed
  // from a consistent snapshot. screen.getCursorScreenPoint() returns
  // the same coordinate space as win.setPosition() — no Retina conversion
  // needed.
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

/** Called from app.on("before-quit") to clean up any in-flight drag
 *  polling timers before the process exits. Without this, a setInterval
 *  could keep the Node event loop alive past app.quit() (Electron
 *  normally still tears down, but defensive cleanup avoids edge cases
 *  + helper-process leaks reported in the wild). */
export function cleanupAllDrags(): void {
  for (const state of drags.values()) {
    clearInterval(state.interval);
  }
  drags.clear();
}

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

export function getOpenConnectionIds(): string[] {
  return Array.from(windowsByConnectionId.keys());
}

export function hasAnyWindow(): boolean {
  return windowsByConnectionId.size > 0 || welcomeWindows.size > 0;
}

async function persistOpenWindows(): Promise<void> {
  const ids = Array.from(windowsByConnectionId.keys());
  await setConfig((current) => ({ ...current, openWindows: ids }));
}

/** Restore windows for connections that were open at last quit. If none,
 *  shows a single Welcome window. */
export async function restoreOpenWindows(): Promise<void> {
  // Import dynamically to avoid an import cycle (store ↔ window-manager).
  const { getConfig } = await import("./config/store.js");
  const config = await getConfig();
  const ids = config.openWindows ?? [];
  let restored = 0;
  for (const id of ids) {
    if (config.connections.some((c) => c.id === id)) {
      openConnectionWindow(id);
      restored++;
    }
  }
  if (restored === 0) openWelcomeWindow();
}
