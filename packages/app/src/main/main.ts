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

import { rmSync } from "node:fs";
import { app, BrowserWindow } from "electron";
import { registerIpc } from "./ipc.js";
import { buildMenu } from "./menu.js";
import {
  cleanupLeakedEphemeralDirs,
  getActiveEphemeralDir,
  shutdownBuiltInServer,
} from "./server-supervisor.js";
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

      // Eager-clean any ephemeral "Try it out" dirs left over from prior
      // Desktop crashes (anything older than 1 hour). macOS auto-cleans
      // $TMPDIR every ~3 days, but eager cleanup keeps the dir count low.
      cleanupLeakedEphemeralDirs();

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

    // Rm-rf the ephemeral dir SYNCHRONOUSLY before kicking off shutdown.
    // shutdownBuiltInServer waits up to 5s for the child to exit, but the
    // force-exit timer below fires at 1s, so the async cleanup inside the
    // supervisor would lose the race and leak the temp dir. The child
    // holds file handles open inside the dir; Unix permits removing the
    // dir while handles are open — the inodes are gc'd on close.
    const ephemeral = getActiveEphemeralDir();
    if (ephemeral) {
      try {
        rmSync(ephemeral, { recursive: true, force: true });
      } catch {
        // Best-effort. cleanupLeakedEphemeralDirs on next boot will retry.
      }
    }

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
