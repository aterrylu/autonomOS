/**
 * Preload bridge exposed to the renderer process.
 *
 * Phase 1B.2.0: minimal — only exposes `shell` info (platform, version) so
 * the renderer can detect "I am running inside the desktop app." Actual
 * IPC API surface (`connections.*`, `localServer.*`, deep-link events)
 * lands in 1B.2.2+.
 *
 * `contextIsolation: true` is mandatory; everything the renderer sees is
 * funneled through `contextBridge.exposeInMainWorld`.
 */

import { contextBridge } from "electron";

contextBridge.exposeInMainWorld("autonomosShell", {
  /** Bumped when the preload contract changes in a breaking way. */
  version: 1,
  platform: process.platform,
  arch: process.arch,
  /** True iff this is the Electron-hosted desktop app, false in a plain
   *  browser visiting the web dashboard. Renderer code can use this to
   *  enable/disable desktop-specific UI (workspace sidebar, etc.). */
  isDesktop: true,
} as const);
