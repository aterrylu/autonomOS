// Electron main process entry point.
//
// Per ADR-028: this process MUST NOT spawn an autonomos-server child in
// production. The bundled server in `Resources/server/` is invoked only by
// the local-install flow (which calls `autonomos install-service` to hand
// supervision over to launchd).
//
// Window model: VS Code style — one BrowserWindow per connection. Multi-
// connection handled by macOS window management, not an in-app sidebar.
// See docs/research/desktop-as-thin-client.md.

import { app, BrowserWindow } from "electron";

import { URL_SCHEME } from "../shared/constants.js";
import { registerIpc } from "./ipc.js";
import { buildMenu } from "./menu.js";
import {
  cleanupAllDrags,
  hasAnyWindow,
  openWelcomeWindow,
  restoreOpenWindows,
} from "./window-manager.js";

/** Deep-link URLs received before any window is ready. Drained by the first
 *  Welcome window once 1B.2.4 wires the protocol handler logic. */
const pendingDeepLinks: string[] = [];

/** Set to true when the user has actively requested quit (⌘Q, Dock menu →
 *  Quit, app.quit() programmatically). On macOS, window-all-closed without
 *  this flag means "user closed all windows but didn't quit" — we keep the
 *  app alive in the Dock (VS Code / standard Mac app pattern). */
let quitRequested = false;

function bootstrap(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, argv) => {
    const url = argv.find((arg) => arg.startsWith(`${URL_SCHEME}://`));
    if (url) pendingDeepLinks.push(url);
    // A second-instance request without a URL is just "the user re-launched
    // the .app" — open a welcome window so they're not stranded.
    if (!hasAnyWindow()) openWelcomeWindow();
  });

  // CRITICAL: open-url MUST be registered synchronously, not inside
  // whenReady().then() — events arriving before whenReady are dropped
  // unless a listener is already attached.
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
      await restoreOpenWindows();
    })
    .catch((err) => {
      console.error("[main] Bootstrap failed:", err);
      app.quit();
    });

  app.on("activate", () => {
    // macOS: clicking the dock icon while no window is open re-opens one.
    if (!hasAnyWindow()) openWelcomeWindow();
  });

  app.on("window-all-closed", () => {
    // VS Code pattern (verified against vscode/src/vs/platform/lifecycle/
    // electron-main/lifecycleMainService.ts):
    //   * Linux/Windows: quit when last window closes
    //   * macOS: quit ONLY if quit was already requested (⌘Q, Dock → Quit)
    //     — otherwise stay alive in Dock so the user can ⌘N to reopen
    //
    // This matches the standard Mac app convention. The user can quit via
    // ⌘Q or right-click Dock icon → Quit.
    if (quitRequested || process.platform !== "darwin") {
      app.quit();
    }
  });

  app.on("before-quit", () => {
    quitRequested = true;

    // Cleanup drag-polling setIntervals so they don't hold the event
    // loop open past app.exit().
    cleanupAllDrags();

    // Destroy all windows so their webview renderer + GPU helper
    // processes get torn down promptly. win.destroy() (unlike win.close())
    // bypasses any beforeunload handlers and synchronously kills the
    // window's webContents — including embedded <webview> children.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }

    // Belt-and-suspenders force-exit fallback: if the renderers are
    // taking too long to acknowledge shutdown (this is the bug that
    // leaks helper processes — Electron's graceful quit waits for the
    // renderer to confirm, and if it's stuck, it never confirms),
    // hard-exit the process after 1 second. VS Code does the same in
    // its kill() path.
    setTimeout(() => {
      // biome-ignore lint/suspicious/noConsole: diagnostic on forced exit
      console.warn("[main] forced exit — renderers did not quit in 1s");
      app.exit(0);
    }, 1000).unref();
  });
}

bootstrap();
