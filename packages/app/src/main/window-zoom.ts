// Title-bar double-click ("zoom") decision logic, electron-free so it can be
// unit-tested in a plain `node --test` process (same precedent as
// drag-controller.ts / window-options.ts). The caller (ipc.ts) resolves the
// BrowserWindow and reads the macOS user preference; this module only decides
// what to do with them.

/** The narrow window surface a zoom needs. Real BrowserWindow satisfies it. */
export interface ZoomableWindow {
  isMaximized(): boolean;
  maximize(): void;
  unmaximize(): void;
  minimize(): void;
}

/**
 * Apply the platform-native title-bar double-click action.
 *
 * `appleActionOnDoubleClick` is the macOS user default
 * `AppleActionOnDoubleClick` (System Settings → Desktop & Dock →
 * "Double-click a window's title bar to…"):
 *   - "Minimize" → minimize the window
 *   - "None"     → do nothing
 *   - "Maximize", "" (unset), or undefined (non-darwin) → toggle zoom
 *   - "Fill" (macOS 15+) and any future value → toggle zoom; Electron has
 *     no fill primitive, so maximize is the closest approximation
 */
export function performTitleBarDoubleClick(
  win: ZoomableWindow,
  appleActionOnDoubleClick: string | undefined,
): void {
  if (appleActionOnDoubleClick === "None") return;
  if (appleActionOnDoubleClick === "Minimize") {
    win.minimize();
    return;
  }
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
}
