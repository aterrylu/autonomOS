/**
 * Electron main process entry point.
 *
 * Phase 1B.2.0 (this commit): just gets `bun run dev:app` to open a blank
 * BrowserWindow. No connections, no server-spawn, no IPC. This is the
 * scaffolding step — subsequent 1B.2.x sub-phases fill in the missing pieces.
 *
 * Per ADR-028: this process MUST NOT spawn an autonomos-server child in
 * production. The bundled server in `Resources/server/` is invoked only by
 * the local-install flow (which calls `autonomos install-service` to hand
 * supervision over to launchd).
 *
 * Module structure (per docs/research/desktop-as-thin-client.md):
 *   main/main.ts             ← bootstrap, app lifecycle (KEEP ≤ 200 LOC)
 *   main/window-manager.ts   ← BrowserWindow + webview creation (1B.2.3)
 *   main/deep-links.ts       ← autonomos:// protocol handling (1B.2.4)
 *   main/local-server/       ← install / state / lifecycle (1B.2.5)
 *   main/config/             ← store / tokens / migration (1B.2.1)
 *   main/ipc.ts              ← contextBridge API surface (1B.2.2+)
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;

function createMainWindow(): BrowserWindow {
  // Mac-specific window chrome bundled together so `exactOptionalPropertyTypes`
  // doesn't reject `vibrancy: undefined` (Electron's type doesn't include
  // undefined in the union, so we conditionally omit instead).
  const macChrome =
    process.platform === "darwin"
      ? ({ titleBarStyle: "hiddenInset", vibrancy: "sidebar" } as const)
      : {};

  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0e14",
    show: false,
    ...macChrome,
    webPreferences: {
      preload: resolve(__dirname, "../preload/main.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  // 1B.2.0 scaffolding: load a minimal placeholder. 1B.2.2 swaps this for
  // the renderer bundle showing Welcome / sidebar / webviews.
  window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html><head><meta charset="utf-8">
      <title>autonomOS — Phase 1B.2.0</title>
      <style>
        body { margin: 0; padding: 0; background: #0a0e14; color: #cbd5e1;
               font-family: -apple-system, BlinkMacSystemFont, sans-serif;
               display: flex; align-items: center; justify-content: center;
               height: 100vh; }
        .pill { padding: 12px 20px; border-radius: 12px;
                background: rgba(255,255,255,0.04); font-size: 14px;
                border: 1px solid rgba(255,255,255,0.06); }
        code { background: rgba(255,255,255,0.06); padding: 2px 6px;
               border-radius: 4px; }
      </style>
      </head><body>
      <div class="pill">
        autonomOS Desktop · Phase 1B.2.0 scaffolding · renderer not yet wired ·
        next: <code>1B.2.1</code> connection types + persistence
      </div>
      </body></html>
    `)}`,
  );

  window.once("ready-to-show", () => window.show());

  window.on("closed", () => {
    mainWindow = null;
  });

  return window;
}

function bootstrap(): void {
  // Single-instance lock — required for deep-link handoff to an existing
  // window (1B.2.4). Wired now so we don't fight the second-instance
  // race later.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    mainWindow = createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

bootstrap();
