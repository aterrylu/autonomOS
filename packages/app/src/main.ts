// autonomOS Desktop — Electron main process.
//
// Responsibilities:
//   1. Spawn the autonomos-server child (Phase 1A.1 binary, embedded mode)
//   2. Wait for AUTONOMOS_READY, capture actual port
//   3. Set the auth cookie on the default session so the webview is
//      authenticated without prompting
//   4. Open a BrowserWindow pointed at the spawned server
//   5. On quit, SIGTERM the server child (L1 — Pattern 2 + state recovery)

import { app, BrowserWindow, session } from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shutdownServer,
  spawnServer,
  type ServerHandle,
} from "./server-supervisor.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let serverHandle: ServerHandle | null = null;
let mainWindow: BrowserWindow | null = null;
let quitting = false;

async function bootstrap(): Promise<void> {
  // 1. Spawn server child & wait for AUTONOMOS_READY
  serverHandle = await spawnServer();
  const baseUrl = `http://127.0.0.1:${serverHandle.port}`;

  // 2. Set the auth cookie before loading the URL so the webview is
  //    immediately authenticated. (Server's middleware accepts the cookie
  //    OR the ?token query param; cookie is cleaner because it persists
  //    across reloads/navigations.)
  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: "autonomos_token",
    value: serverHandle.token,
    sameSite: "lax",
    path: "/",
    // httpOnly stays false so JS in the dashboard can introspect if needed,
    // matching the server's behavior when a user authenticates via /auth.
  });

  // 3. Open the window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "autonomOS",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    vibrancy: process.platform === "darwin" ? "sidebar" : undefined,
    backgroundColor: "#0a0e14",
    webPreferences: {
      preload: resolve(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload script uses contextBridge; needs node modules
    },
  });

  await mainWindow.loadURL(baseUrl);
}

app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (err) {
    console.error("[main] bootstrap failed:", err);
    app.exit(1);
  }
});

app.on("window-all-closed", () => {
  // L1: when the window closes, we shut down. The server stops with us;
  // agent state is persisted to disk and resumes via `claude --resume`
  // when the user reopens.
  app.quit();
});

app.on("before-quit", async (event) => {
  if (quitting) return; // re-entrant guard while shutdown completes
  if (!serverHandle || serverHandle.child.exitCode !== null) return;
  // Block the quit just long enough to send SIGTERM and wait for the
  // server child to flush + exit cleanly.
  event.preventDefault();
  quitting = true;
  await shutdownServer(serverHandle);
  app.quit();
});

// macOS: clicking the dock icon when all windows are closed should re-open.
// (Only relevant for app re-activation; on first launch, whenReady creates
// the window via bootstrap.)
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
    void bootstrap().catch((err) => {
      console.error("[main] re-bootstrap on activate failed:", err);
    });
  }
});
