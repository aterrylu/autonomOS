// Electron main process entry point.
//
// ADR-029 flow:
//   1. Single-instance lock.
//   2. Splash window shows immediately.
//   3. Background: server-supervisor.acquireOrConnect() spawns or detects
//      a server (Built-in or Always-on).
//   4. Splash closes; "This Mac" connection window opens loaded with the
//      server's URL (cookie auth via existing webview pipeline).
//   5. before-quit: shutdown Built-in server child (if any), clear drag
//      intervals, force-exit after 1s.

import { app, BrowserWindow } from "electron";

import { URL_SCHEME } from "../shared/constants.js";
import { registerIpc } from "./ipc.js";
import { buildMenu } from "./menu.js";
import {
  acquireOrConnect,
  shutdownBuiltInServer,
} from "./server-supervisor.js";
import {
  cleanupAllDrags,
  closeSplash,
  hasAnyWindow,
  openConnectionWindow,
  openSplashWindow,
  openWelcomeWindow,
  restoreOpenWindows,
} from "./window-manager.js";

const pendingDeepLinks: string[] = [];
let quitRequested = false;

function bootstrap(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith(`${URL_SCHEME}://`));
    if (url) pendingDeepLinks.push(url);
    if (!hasAnyWindow()) openWelcomeWindow();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    pendingDeepLinks.push(url);
  });

  app.setAsDefaultProtocolClient(URL_SCHEME);

  app
    .whenReady()
    .then(async () => {
      registerIpc();
      await buildMenu();

      // Show splash immediately for snappy feedback while the server boots.
      openSplashWindow();

      // Kick off Built-in / Always-on detection. Doesn't block UI thread.
      try {
        await acquireOrConnect();
      } catch (err) {
        console.error("[main] Server acquire failed:", err);
        // If server can't start, still show Welcome so user can add a
        // remote connection.
      }

      // Restore last-open windows (or open the local "This Mac" window).
      await restoreOpenWindows();
      closeSplash();
    })
    .catch((err) => {
      console.error("[main] Bootstrap failed:", err);
      app.quit();
    });

  app.on("activate", () => {
    if (!hasAnyWindow()) openConnectionWindow("local");
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
