import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  performTitleBarDoubleClick,
  type ZoomableWindow,
} from "../window-zoom.js";

/**
 * The zoom module's job is to translate the macOS AppleActionOnDoubleClick
 * user default into the right window call — and to be a plain maximize
 * toggle everywhere else (non-darwin passes `undefined`). The window is
 * injected, so every preference branch is provable without electron.
 */

function fakeWindow(maximized = false): ZoomableWindow & {
  calls: string[];
} {
  const w = {
    calls: [] as string[],
    isMaximized: () => maximized,
    maximize() {
      w.calls.push("maximize");
      maximized = true;
    },
    unmaximize() {
      w.calls.push("unmaximize");
      maximized = false;
    },
    minimize() {
      w.calls.push("minimize");
    },
  };
  return w;
}

describe("performTitleBarDoubleClick", () => {
  it("maximizes an unmaximized window on the default action", () => {
    const win = fakeWindow(false);
    performTitleBarDoubleClick(win, "Maximize");
    assert.deepEqual(win.calls, ["maximize"]);
  });

  it("unmaximizes a maximized window (toggle, like native zoom)", () => {
    const win = fakeWindow(true);
    performTitleBarDoubleClick(win, "Maximize");
    assert.deepEqual(win.calls, ["unmaximize"]);
  });

  it("two double-clicks round-trip: maximize then unmaximize", () => {
    const win = fakeWindow(false);
    performTitleBarDoubleClick(win, "Maximize");
    performTitleBarDoubleClick(win, "Maximize");
    assert.deepEqual(win.calls, ["maximize", "unmaximize"]);
  });

  it('"Minimize" preference minimizes instead of zooming', () => {
    const win = fakeWindow(false);
    performTitleBarDoubleClick(win, "Minimize");
    assert.deepEqual(win.calls, ["minimize"]);
  });

  it('"Minimize" preference minimizes even when already maximized', () => {
    const win = fakeWindow(true);
    performTitleBarDoubleClick(win, "Minimize");
    assert.deepEqual(win.calls, ["minimize"]);
  });

  it('"None" preference does nothing', () => {
    const win = fakeWindow(false);
    performTitleBarDoubleClick(win, "None");
    assert.deepEqual(win.calls, []);
  });

  it("undefined preference (non-darwin) falls back to the zoom toggle", () => {
    const win = fakeWindow(false);
    performTitleBarDoubleClick(win, undefined);
    assert.deepEqual(win.calls, ["maximize"]);
  });

  it("empty-string preference (default unset on macOS) zooms", () => {
    const win = fakeWindow(false);
    performTitleBarDoubleClick(win, "");
    assert.deepEqual(win.calls, ["maximize"]);
  });

  it('"Fill" (macOS 15+) is deliberately approximated as the zoom toggle', () => {
    const win = fakeWindow(false);
    performTitleBarDoubleClick(win, "Fill");
    assert.deepEqual(win.calls, ["maximize"]);
  });

  it("an unrecognized preference value falls back to the zoom toggle", () => {
    const win = fakeWindow(true);
    performTitleBarDoubleClick(win, "SomethingFutureMacOSAdds");
    assert.deepEqual(win.calls, ["unmaximize"]);
  });
});
