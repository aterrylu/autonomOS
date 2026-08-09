// @vitest-environment jsdom
import { act, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { isMac } from "../utils/platform";
import { pushEscapeCloser } from "./escapeStack";
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

  it("mod+digit switches to the Nth SIDEBAR agent (published row order)", () => {
    useStore.setState({
      sidebarRowOrder: ["agent-a", "agent-b", "agent-c"],
      activePane: null,
    });
    const { unmount } = renderHook(() => useShortcuts(true));
    pressMod("2", "Digit2");
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "agent-b",
    });
    pressMod("1", "Digit1");
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "agent-a",
    });
    unmount();
    useStore.setState({ sidebarRowOrder: [], activePane: null });
  });

  it("out-of-range digit and an empty sidebar are safe no-ops (chord still consumed)", () => {
    useStore.setState({ sidebarRowOrder: [], activePane: null });
    const { unmount } = renderHook(() => useShortcuts(true));
    const e1 = pressMod("5", "Digit5");
    expect(e1.defaultPrevented).toBe(true); // reserved chord is still consumed
    expect(useStore.getState().activePane).toBeNull();

    useStore.setState({ sidebarRowOrder: ["agent-a", "agent-b"] });
    const e2 = pressMod("7", "Digit7"); // only 2 agents
    expect(e2.defaultPrevented).toBe(true);
    expect(useStore.getState().activePane).toBeNull();
    unmount();
    useStore.setState({ sidebarRowOrder: [] });
  });

  it("mod+arrows navigate relative to the active agent, clamped at the ends", () => {
    useStore.setState({
      sidebarRowOrder: ["a", "b", "c"],
      activePane: { type: "session", id: "b" },
    });
    const { unmount } = renderHook(() => useShortcuts(true));

    pressMod("ArrowDown", "ArrowDown");
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "c",
    });
    pressMod("ArrowDown", "ArrowDown"); // already last → clamp, no wrap
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "c",
    });
    pressMod("ArrowUp", "ArrowUp");
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "b",
    });
    unmount();
    useStore.setState({ sidebarRowOrder: [], activePane: null });
  });

  it("mod+arrows with no active session enter the list at top (↓) / bottom (↑)", () => {
    useStore.setState({
      sidebarRowOrder: ["a", "b", "c"],
      activePane: null,
    });
    const { unmount } = renderHook(() => useShortcuts(true));
    pressMod("ArrowDown", "ArrowDown");
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "a",
    });
    useStore.setState({ activePane: { type: "orgchart", id: "orgchart" } });
    pressMod("ArrowUp", "ArrowUp");
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "c",
    });
    unmount();
    useStore.setState({ sidebarRowOrder: [], activePane: null });
  });

  it("mod+arrows pass through while typing in a real field, but win over the terminal's textarea", () => {
    useStore.setState({
      sidebarRowOrder: ["a", "b"],
      activePane: { type: "session", id: "a" },
    });
    const { unmount } = renderHook(() => useShortcuts(true));

    // Focus a REAL editable field: chord must pass through un-consumed
    // (native caret motion keeps working, no agent switch, no focus yank).
    const field = document.createElement("textarea");
    document.body.appendChild(field);
    field.focus();
    const inField = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      code: "ArrowDown",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(inField);
    expect(inField.defaultPrevented).toBe(false);
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "a",
    });

    // xterm's helper textarea is the TERMINAL — the chord must still fire.
    const helper = document.createElement("textarea");
    helper.classList.add("xterm-helper-textarea");
    document.body.appendChild(helper);
    helper.focus();
    const inTerminal = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      code: "ArrowDown",
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
      cancelable: true,
    });
    helper.dispatchEvent(inTerminal);
    expect(inTerminal.defaultPrevented).toBe(true);
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "b",
    });

    // Digits have no caret semantics — they still fire inside fields.
    field.focus();
    pressMod("1", "Digit1");
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "a",
    });

    field.remove();
    helper.remove();
    unmount();
    useStore.setState({ sidebarRowOrder: [], activePane: null });
  });

  it("mod+k toggles the quick-switcher", () => {
    const { unmount } = renderHook(() => useShortcuts(true));
    const e = pressMod("k", "KeyK");
    expect(e.defaultPrevented).toBe(true);
    expect(useStore.getState().quickSwitchOpen).toBe(true);
    pressMod("k", "KeyK");
    expect(useStore.getState().quickSwitchOpen).toBe(false);
    unmount();
  });

  it("agent-switching chords stand down while the palette is open", () => {
    useStore.setState({
      sidebarRowOrder: ["a", "b", "c"],
      activePane: { type: "session", id: "a" },
      quickSwitchOpen: true,
    });
    const { unmount } = renderHook(() => useShortcuts(true));

    const digit = pressMod("2", "Digit2");
    expect(digit.defaultPrevented).toBe(false); // passes through, no match
    const arrow = pressMod("ArrowDown", "ArrowDown");
    expect(arrow.defaultPrevented).toBe(false);
    const sidebar = pressMod("b", "KeyB");
    expect(sidebar.defaultPrevented).toBe(false);
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "a", // nothing switched behind the modal
    });

    // mod+K still toggles (that's how you close it from the keyboard)…
    pressMod("k", "KeyK");
    expect(useStore.getState().quickSwitchOpen).toBe(false);
    // …and the chords come back once closed.
    pressMod("2", "Digit2");
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "b",
    });
    unmount();
    useStore.setState({ sidebarRowOrder: [], activePane: null });
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

  it("Escape in a popover's text field blurs the field (draft kept); second Escape closes", () => {
    const closer = vi.fn();
    const pop = pushEscapeCloser(closer); // an open popover
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.value = "half-typed session key";
    field.focus();

    const { unmount } = renderHook(() => useShortcuts(true));
    const first = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(true); // consumed by ui.dismiss…
    expect(closer).not.toHaveBeenCalled(); // …but the popover did NOT close
    expect(document.activeElement).not.toBe(field); // the field was blurred
    expect(field.value).toBe("half-typed session key"); // draft intact

    const second = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(second);
    expect(closer).toHaveBeenCalledTimes(1); // now it closes

    pop();
    field.remove();
    unmount();
  });

  it("Escape in a MODAL DIALOG's input closes it (⌘K palette) — no draft-blur", () => {
    const closer = vi.fn();
    const pop = pushEscapeCloser(closer);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const field = document.createElement("input"); // e.g. the palette search
    dialog.appendChild(field);
    document.body.appendChild(dialog);
    field.focus();

    const { unmount } = renderHook(() => useShortcuts(true));
    const esc = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(esc);
    // Closes immediately (the search query is not a draft to protect, and the
    // palette's key handlers live on this input — blurring would strand it).
    expect(closer).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field); // NOT blurred

    pop();
    dialog.remove();
    unmount();
  });

  it("Escape in xterm's helper textarea still closes immediately (it is the terminal, not a draft)", () => {
    const closer = vi.fn();
    const pop = pushEscapeCloser(closer);
    const helper = document.createElement("textarea");
    helper.classList.add("xterm-helper-textarea");
    document.body.appendChild(helper);
    helper.focus();

    const { unmount } = renderHook(() => useShortcuts(true));
    const esc = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    helper.dispatchEvent(esc);
    expect(closer).toHaveBeenCalledTimes(1);

    pop();
    helper.remove();
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
