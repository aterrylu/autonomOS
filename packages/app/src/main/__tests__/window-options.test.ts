import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { macWindowOptions } from "../window-options.js";

/**
 * macWindowOptions encodes a hard-won perf invariant from #176: NO `vibrancy`.
 *
 * Stacking macOS window vibrancy under the renderer's CSS `backdrop-filter`
 * pegged the GPU compositor at ~195% on an *idle* Welcome window. The CSS half
 * of that fix is guarded by validate-dmg-cdp.mjs (it scans computed styles),
 * but a BrowserWindow *constructor option* is invisible to a DOM scan — so this
 * unit test is its counterpart. It fails the instant anyone re-adds a vibrancy
 * key, which is the most likely way the peg silently returns.
 */

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}
afterEach(() => setPlatform(realPlatform));

describe("macWindowOptions", () => {
  it("never sets `vibrancy` on macOS (the #176 GPU-peg invariant)", () => {
    setPlatform("darwin");
    const opts = macWindowOptions();
    assert.ok(
      !("vibrancy" in opts),
      `vibrancy must stay unset — re-adding it reintroduces the #176 idle-CPU ` +
        `peg (vibrancy stacked under CSS backdrop-filter). Got: ${JSON.stringify(opts)}`,
    );
  });

  it("uses the hiddenInset title bar on macOS", () => {
    setPlatform("darwin");
    assert.equal(macWindowOptions().titleBarStyle, "hiddenInset");
  });

  it("returns no macOS-only options off darwin", () => {
    setPlatform("linux");
    assert.deepEqual(macWindowOptions(), {});
  });
});
