// Electron main process entry point.
//
// ADR-029 flow:
//   1. Single-instance lock (so two Desktops can't race for the same
//      ~/.autonomos/ config).
//   2. Open Welcome window — every launch shows the picker.
//   3. User picks: Built-in / Always-on / Remote.
//   4. WelcomeWindow handles the IPC → spawns a connection window for
//      the chosen target and closes itself.
//   5. before-quit: shutdown Built-in server child (if any), clear drag
//      intervals, force-exit after 1s.

import { app, BrowserWindow } from "electron";

import { registerIpc } from "./ipc.js";
import { buildMenu } from "./menu.js";
import { shutdownBuiltInServer } from "./server-supervisor.js";
import {
  cleanupAllDrags,
  hasAnyWindow,
  openWelcomeWindow,
} from "./window-manager.js";

let quitRequested = false;

function bootstrap(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // Second-instance launch (user double-clicked the .app while already
  // running) — surface the existing window or open Welcome.
  app.on("second-instance", () => {
    if (!hasAnyWindow()) openWelcomeWindow();
  });

  app
    .whenReady()
    .then(async () => {
      registerIpc();
      await buildMenu();

      // Welcome-every-launch (per user UX decision): show the picker
      // every time the app opens. The Welcome window itself DETECTs an
      // existing daemon and surfaces it as a one-click option, but we
      // don't auto-connect — the user explicitly picks.
      openWelcomeWindow();
    })
    .catch((err) => {
      console.error("[main] Bootstrap failed:", err);
      app.quit();
    });

  app.on("activate", () => {
    if (!hasAnyWindow()) openWelcomeWindow();
  });

  app.on("window-all-closed", () => {
    if (quitRequested || process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    quitRequested = true;
    cleanupAllDrags();

    // Shutdown Built-in server (no-op if Always-on or no active server).
    void shutdownBuiltInServer().catch(() => undefined);

    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }

    setTimeout(() => {
      console.warn("[main] forced exit — renderers did not quit in 1s");
      app.exit(0);
    }, 1000).unref();
  });
}

bootstrap();
