// Electron main process entry point.
//
// Per ADR-028: this process MUST NOT spawn an autonomos-server child in
// production. The bundled server in `Resources/server/` is invoked only
// by the local-install flow (which calls `autonomos install-service` to
// hand supervision over to launchd).
//
// Module structure (see docs/research/desktop-as-thin-client.md):
//   main/main.ts             ← bootstrap + lifecycle  (KEEP ≤ 200 LOC)
//   main/window-manager.ts   ← BrowserWindow per connection (1B.2.3)
//   main/deep-links.ts       ← autonomos:// handler   (1B.2.4)
//   main/local-server/       ← install + state + lifecycle (1B.2.5)
//   main/config/             ← store + tokens + migration (1B.2.1 ✓)
//   main/ipc.ts              ← contextBridge surface  (1B.2.2+)

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
} from "electron";

import { URL_SCHEME } from "../shared/constants.js";
import { registerIpc } from "./ipc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
/** Deep-link URLs received before the renderer is ready. Drained on
 *  app.whenReady(). 1B.2.4 wires the actual handler; here we just buffer
 *  so cold-launch-via-URL events aren't dropped (a real Electron footgun
 *  flagged by the design audit). */
const pendingDeepLinks: string[] = [];

function macWindowOptions(): Partial<BrowserWindowConstructorOptions> {
  if (process.platform !== "darwin") return {};
  return { titleBarStyle: "hiddenInset", vibrancy: "sidebar" };
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
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

  window.loadFile(resolve(__dirname, "../renderer/index.html"));

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    mainWindow = null;
  });
  return window;
}

function bootstrap(): void {
  // Single-instance lock is a TOP-LEVEL requirement (not just for deep-link
  // handoff). Two desktop instances pointing at the same tokens.dat /
  // config.json would torn-write — the Promise-chain lock in config/store.ts
  // is process-local. See ADR-028 implications.
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // Deep-link / re-launch handoff to the existing window. argv may carry an
  // autonomos:// URL on Linux/Windows cold-launch; macOS uses open-url.
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const url = argv.find((arg) => arg.startsWith(`${URL_SCHEME}://`));
    if (url) pendingDeepLinks.push(url);
  });

  // CRITICAL: open-url listener MUST be registered synchronously here, NOT
  // inside whenReady().then(). On macOS, open-url events that arrive before
  // whenReady resolves are queued only if a listener is attached. Without
  // this, cold-launch-via-deep-link silently no-ops. (Real Electron pitfall.)
  app.on("open-url", (event, url) => {
    event.preventDefault();
    pendingDeepLinks.push(url);
  });

  // Register the autonomos:// scheme with the OS. On macOS this writes to
  // LaunchServices via Info.plist (synthesized by electron-builder from
  // electron-builder.yml's `protocols:` block). Calling here covers the
  // dev workflow where Info.plist isn't applied.
  app.setAsDefaultProtocolClient(URL_SCHEME);

  app
    .whenReady()
    .then(() => {
      registerIpc();
      mainWindow = createMainWindow();
      // 1B.2.4 will drain pendingDeepLinks here and route to the modal.

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          mainWindow = createMainWindow();
        }
      });
    })
    .catch((err) => {
      console.error("[main] Bootstrap failed:", err);
      app.quit();
    });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

bootstrap();
