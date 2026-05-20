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

import { app } from "electron";

import { URL_SCHEME } from "../shared/constants.js";
import { registerIpc } from "./ipc.js";
import { buildMenu } from "./menu.js";
import {
  hasAnyWindow,
  openWelcomeWindow,
  restoreOpenWindows,
} from "./window-manager.js";

/** Deep-link URLs received before any window is ready. Drained by the first
 *  Welcome window once 1B.2.4 wires the protocol handler logic. */
const pendingDeepLinks: string[] = [];

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
    // On macOS, apps traditionally stay alive even with all windows closed
    // (the user can ⌘N to reopen). On other platforms, quit.
    if (process.platform !== "darwin") app.quit();
  });
}

bootstrap();
