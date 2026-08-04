// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import type { DockviewApi } from "dockview-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { isMac } from "../utils/platform";
import { registerDockviewApi, unregisterDockviewApi } from "./dockviewApi";
import { ShortcutHelpOverlay } from "./ShortcutHelpOverlay";
import { useShortcuts } from "./useShortcuts";

// focusTerminal (called by pane actions) polls via requestAnimationFrame;
// stub it if the jsdom build in CI lacks one.
beforeEach(() => {
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame ??= ((id: number) =>
    clearTimeout(id)) as typeof cancelAnimationFrame;
});

/** Dispatch a keydown on window with the platform primary modifier. */
function pressMod(key: string, code: string, extra: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", {
    key,
    code,
    metaKey: isMac,
    ctrlKey: !isMac,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  window.dispatchEvent(e);
  return e;
}

/** Minimal fake DockviewApi: 3 panes visually ordered [A | C] | B. */
function fakeDockviewApi() {
  const setActive = vi.fn();
  const panels = new Map(
    ["A", "B", "C"].map((id) => [
      id,
      { id, api: { setActive: () => setActive(id) } },
    ]),
  );
  const api = {
    toJSON: () => ({
      grid: {
        root: {
          type: "branch",
          data: [
            {
              type: "branch",
              data: [
                { type: "leaf", data: { views: ["A"] } },
                { type: "leaf", data: { views: ["C"] } },
              ],
            },
            { type: "leaf", data: { views: ["B"] } },
          ],
        },
      },
    }),
    // Insertion order (A,B,C) deliberately differs from visual order (A,C,B).
    panels: ["A", "B", "C"].map((id) => panels.get(id)),
    getPanel: (id: string) => panels.get(id),
  } as unknown as DockviewApi;
  return { api, setActive };
}

describe("useShortcuts dispatcher", () => {
  afterEach(() => {
    useStore.setState({ shortcutHelpOpen: false });
  });

  it("does nothing when disabled (login screen)", () => {
    const before = useStore.getState().sidebarOpen;
    renderHook(() => useShortcuts(false));
    const e = pressMod("b", "KeyB");
    expect(e.defaultPrevented).toBe(false);
    expect(useStore.getState().sidebarOpen).toBe(before);
  });

  it("mod+b toggles the sidebar and consumes the event", () => {
    const before = useStore.getState().sidebarOpen;
    const { unmount } = renderHook(() => useShortcuts(true));
    const e = pressMod("b", "KeyB");
    expect(e.defaultPrevented).toBe(true);
    expect(useStore.getState().sidebarOpen).toBe(!before);
    unmount();
  });

  it("mod+digit activates the Nth pane in VISUAL order", () => {
    const { api, setActive } = fakeDockviewApi();
    registerDockviewApi(api);
    const { unmount } = renderHook(() => useShortcuts(true));
    // Visual order is A, C, B — mod+2 must hit C (api.panels would say B).
    pressMod("2", "Digit2");
    expect(setActive).toHaveBeenCalledWith("C");
    unmount();
    unregisterDockviewApi(api);
  });

  it("mod+9 activates the LAST pane", () => {
    const { api, setActive } = fakeDockviewApi();
    registerDockviewApi(api);
    const { unmount } = renderHook(() => useShortcuts(true));
    pressMod("9", "Digit9");
    expect(setActive).toHaveBeenCalledWith("B");
    unmount();
    unregisterDockviewApi(api);
  });

  it("out-of-range digit and unmounted dock are safe no-ops", () => {
    const { unmount } = renderHook(() => useShortcuts(true));
    // No dock registered at all.
    const e1 = pressMod("5", "Digit5");
    expect(e1.defaultPrevented).toBe(true); // reserved chord is still consumed

    const { api, setActive } = fakeDockviewApi();
    registerDockviewApi(api);
    pressMod("7", "Digit7"); // only 3 panes open
    expect(setActive).not.toHaveBeenCalled();
    unmount();
    unregisterDockviewApi(api);
  });

  it("falls back to insertion order (with a warning) when the serialized shape drifts", () => {
    // Simulates a dockview upgrade changing toJSON(): the walker finds nothing,
    // but panels exist. Shortcuts must degrade to insertion order, not go dead.
    const setActive = vi.fn();
    const panels = new Map(
      ["A", "B", "C"].map((id) => [
        id,
        { id, api: { setActive: () => setActive(id) } },
      ]),
    );
    const api = {
      toJSON: () => ({ grid: { root: { kind: "unrecognized" } } }),
      panels: ["A", "B", "C"].map((id) => panels.get(id)),
      getPanel: (id: string) => panels.get(id),
    } as unknown as DockviewApi;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerDockviewApi(api);
    const { unmount } = renderHook(() => useShortcuts(true));
    pressMod("2", "Digit2");
    expect(setActive).toHaveBeenCalledWith("B"); // insertion order, 2nd panel
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("serialized layout shape may have changed"),
    );
    warn.mockRestore();
    unmount();
    unregisterDockviewApi(api);
  });

  it("mod+/ opens the help overlay; Escape closes it; Escape passes through when closed", () => {
    // The overlay must be MOUNTED: Escape dismissal rides the escape stack,
    // which the HelpDialog registers on while open (not the store flag).
    const view = render(<ShortcutHelpOverlay />);
    const { unmount } = renderHook(() => useShortcuts(true));
    // act() flushes the store-driven render + the HelpDialog mount effect that
    // registers the dialog on the escape stack, before Escape is dispatched.
    act(() => {
      pressMod("/", "Slash");
    });
    expect(useStore.getState().shortcutHelpOpen).toBe(true);

    const escOpen = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(escOpen);
    });
    expect(escOpen.defaultPrevented).toBe(true);
    expect(useStore.getState().shortcutHelpOpen).toBe(false);

    // Overlay closed → Escape is NOT app-reserved, terminals keep it.
    const escClosed = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(escClosed);
    expect(escClosed.defaultPrevented).toBe(false);
    view.unmount();
    unmount();
  });

  it("ignores keys during IME composition (Escape cancels the composition, not the panel)", () => {
    const { unmount } = renderHook(() => useShortcuts(true));
    const view = render(<ShortcutHelpOverlay />);
    act(() => {
      pressMod("/", "Slash");
    });
    expect(useStore.getState().shortcutHelpOpen).toBe(true);

    const composingEsc = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(composingEsc);
    });
    expect(composingEsc.defaultPrevented).toBe(false);
    expect(useStore.getState().shortcutHelpOpen).toBe(true); // panel untouched

    act(() => {
      useStore.getState().closeShortcutHelp();
    });
    view.unmount();
    unmount();
  });

  it("leaves unregistered chords untouched", () => {
    const { unmount } = renderHook(() => useShortcuts(true));
    const plain = new KeyboardEvent("keydown", {
      key: "r",
      code: "KeyR",
      ctrlKey: isMac, // mac secondary ctrl / plain key elsewhere
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    unmount();
  });

  it("stops propagation of reserved chords (what keeps them out of xterm)", () => {
    const seen = vi.fn();
    // Simulates xterm's textarea listener further down the capture path.
    document.body.addEventListener("keydown", seen, true);
    const { unmount } = renderHook(() => useShortcuts(true));
    pressMod("1", "Digit1");
    expect(seen).not.toHaveBeenCalled();
    document.body.removeEventListener("keydown", seen, true);
    unmount();
  });
});
