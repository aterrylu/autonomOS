// Platform-specific BrowserWindow construction options.
//
// Extracted from window-manager.ts (which imports electron at module load and
// so can't be unit-tested) following the drag-controller / ephemeral-cleanup
// precedent: the electron dependency here is TYPE-ONLY (erased at runtime), so
// this module loads in a plain `node --test` process. See window-options.test.ts.

import type { BrowserWindowConstructorOptions } from "electron";

/**
 * macOS-specific BrowserWindow options.
 *
 * PERF INVARIANT (#176) — deliberately omits `vibrancy`. Stacking macOS window
 * vibrancy under the renderer's CSS `backdrop-filter` made the OS re-sample the
 * backdrop every frame, pegging the GPU compositor at ~195% (≈2 full cores) on
 * an *idle* Welcome window with zero JS running. The window has a solid dark
 * `backgroundColor`, so vibrancy was invisible anyway. Re-adding any `vibrancy`
 * key reintroduces the peg.
 *
 * This invariant is guarded on two sides because neither check sees the other:
 *   - window-options.test.ts asserts no `vibrancy` here (a constructor option
 *     the CSS scan can't see)
 *   - validate-dmg-cdp.mjs asserts no `backdrop-filter` / `transition: all` in
 *     the rendered DOM (computed styles the unit test can't see)
 * and the idle-CPU peg-detector in validate-dmg.sh catches a novel regression
 * from any other cause.
 */
export function macWindowOptions(): Partial<BrowserWindowConstructorOptions> {
  if (process.platform !== "darwin") return {};
  return { titleBarStyle: "hiddenInset" };
}
