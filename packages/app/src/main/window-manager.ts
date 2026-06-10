// Multi-window BrowserWindow lifecycle.
//
// ADR-029 (Built-in / Always-on server): the first window opened at app
// launch represents the "This Mac" connection — managed by the server-
// supervisor. Welcome windows (for adding remote connections) remain.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, screen } from "electron";

import { setConfig } from "./config/store.js";
import { DragController } from "./drag-controller.js";
import { macWindowOptions } from "./window-options.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const windowsByConnectionId = new Map<string, BrowserWindow>();
const welcomeWindows = new Set<BrowserWindow>();
let splashWindow: BrowserWindow | null = null;

// ── Manual window drag state ────────────────────────────────────────
//
// The drag state machine lives in ./drag-controller (no electron import) so
// it's unit-testable. Here we bind it to the real electron `screen` + global
// timers. The public start/end/cleanup functions keep their original
// signatures so callers (ipc.ts, main.ts) are unaffected.

const dragController = new DragController({
  getCursor: () => screen.getCursorScreenPoint(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
});

export function startDrag(win: BrowserWindow): void {
  dragController.start(win);
}

export function endDrag(winId: number): void {
  dragController.end(winId);
}

export function cleanupAllDrags(): void {
  dragController.cleanupAll();
}

// ── BrowserWindow factory ───────────────────────────────────────────
//
// macWindowOptions (the #176 no-vibrancy perf invariant) lives in
// ./window-options so it's unit-testable without electron. See that module.

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
  window.once("ready-to-show", () => {
    window.show();
    window.focus();
  });
  window.on("closed", () => {
    windowsByConnectionId.delete(connectionId);
    endDrag(window.id);
    void persistOpenWindows();
  });
  void persistOpenWindows();
  return window;
}

/** Wait for a connection window to be fully ready (renderer first frame
 *  painted). Used by Welcome's "open then close self" handoff so the new
 *  window is definitely visible before we close the Welcome window —
 *  without this, on some macOS versions the new window opens behind the
 *  closing Welcome and never surfaces. */
export async function waitForConnectionWindowReady(
  connectionId: string,
  timeoutMs = 5000,
): Promise<void> {
  const win = windowsByConnectionId.get(connectionId);
  if (!win) return;
  if (win.isVisible()) return;
  await new Promise<void>((resolveFn) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolveFn();
    };
    const onShow = (): void => settle();
    win.once("show", onShow);
    setTimeout(() => {
      win.removeListener("show", onShow);
      settle();
    }, timeoutMs);
  });
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
  // ADR-029: at every launch, open the "local" (This Mac) window FIRST.
  // The local server is the primary surface for our app — Built-in or
  // Always-on. Saved remote connections were previously auto-opened on
  // restart, but that caused stale-token confusion (user sees the
  // dashboard's built-in login form instead of their dashboard) when a
  // remote URL or token had drifted. Remote connections now open via
  // explicit user action: File > Open Recent Server menu, ⌘N, or future
  // sidebar.
  openConnectionWindow("local");
}
