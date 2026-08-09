// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../test/setup-dom";
import type { SessionInfo } from "../store";
import { useStore } from "../store";
import { closeTopEscape, hasEscapeCloser } from "./escapeStack";
import { QuickSwitcher } from "./QuickSwitcher";

function session(id: string, name: string): SessionInfo {
  return {
    id,
    name,
    workingDirectory: "/tmp",
    status: "running",
  } as unknown as SessionInfo;
}

const SESSIONS = [
  session("s-dispatcher", "Dispatcher"),
  session("s-researcher", "Researcher"),
  session("s-delivery", "DeliveryAck"),
];

beforeEach(() => {
  globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame ??= ((id: number) =>
    clearTimeout(id)) as typeof cancelAnimationFrame;
  useStore.setState({
    sessions: SESSIONS,
    sidebarRowOrder: ["s-dispatcher", "s-researcher", "s-delivery"],
    quickSwitchOpen: false,
    activePane: null,
  });
});

afterEach(() => {
  useStore.setState({
    sessions: [],
    sidebarRowOrder: [],
    quickSwitchOpen: false,
    activePane: null,
  });
});

describe("QuickSwitcher", () => {
  it("renders nothing while closed; opens with the input focused and on the escape stack", () => {
    const { container, unmount } = render(<QuickSwitcher />);
    expect(container).toBeEmptyDOMElement();
    expect(hasEscapeCloser()).toBe(false);

    act(() => {
      useStore.setState({ quickSwitchOpen: true });
    });
    const input = screen.getByTestId("quick-switcher-input");
    expect(document.activeElement).toBe(input);
    expect(hasEscapeCloser()).toBe(true);

    act(() => closeTopEscape());
    expect(useStore.getState().quickSwitchOpen).toBe(false);
    expect(hasEscapeCloser()).toBe(false);
    unmount();
  });

  it("empty query lists agents in sidebar order; typing filters", () => {
    const { unmount } = render(<QuickSwitcher />);
    act(() => {
      useStore.setState({ quickSwitchOpen: true });
    });
    let items = screen.getAllByTestId("quick-switcher-item");
    expect(items.map((el) => el.textContent)).toEqual([
      "Dispatcher",
      "Researcher",
      "DeliveryAck",
    ]);

    fireEvent.change(screen.getByTestId("quick-switcher-input"), {
      target: { value: "resear" },
    });
    items = screen.getAllByTestId("quick-switcher-item");
    expect(items).toHaveLength(1);
    expect(items[0]?.textContent).toBe("Researcher");
    unmount();
  });

  it("Enter switches to the selected agent and closes", () => {
    const { unmount } = render(<QuickSwitcher />);
    act(() => {
      useStore.setState({ quickSwitchOpen: true });
    });
    const input = screen.getByTestId("quick-switcher-input");
    fireEvent.change(input, { target: { value: "deliv" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "s-delivery",
    });
    expect(useStore.getState().quickSwitchOpen).toBe(false);
    unmount();
  });

  it("arrow keys move the selection; Enter picks the highlighted agent", () => {
    const { unmount } = render(<QuickSwitcher />);
    act(() => {
      useStore.setState({ quickSwitchOpen: true });
    });
    const input = screen.getByTestId("quick-switcher-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "s-researcher",
    });
    unmount();
  });

  it("arrows on an empty result list don't wedge the selection at -1", () => {
    const { unmount } = render(<QuickSwitcher />);
    act(() => {
      useStore.setState({ quickSwitchOpen: true });
    });
    const input = screen.getByTestId("quick-switcher-input");
    fireEvent.change(input, { target: { value: "zzzz" } });
    fireEvent.keyDown(input, { key: "ArrowDown" }); // must not park at -1
    fireEvent.change(input, { target: { value: "resear" } });
    fireEvent.keyDown(input, { key: "Enter" }); // selection recovered → switches
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "s-researcher",
    });
    unmount();
  });

  it("opening the help overlay closes the switcher (mutual exclusion)", () => {
    const { unmount } = render(<QuickSwitcher />);
    act(() => {
      useStore.setState({ quickSwitchOpen: true });
    });
    act(() => {
      useStore.getState().toggleShortcutHelp();
    });
    expect(useStore.getState().quickSwitchOpen).toBe(false);
    expect(useStore.getState().shortcutHelpOpen).toBe(true);
    act(() => {
      useStore.getState().toggleQuickSwitch();
    });
    expect(useStore.getState().shortcutHelpOpen).toBe(false);
    expect(useStore.getState().quickSwitchOpen).toBe(true);
    act(() => {
      useStore.setState({ shortcutHelpOpen: false, quickSwitchOpen: false });
    });
    unmount();
  });

  it("no-match query shows the empty state and Enter is a no-op", () => {
    const { unmount } = render(<QuickSwitcher />);
    act(() => {
      useStore.setState({ quickSwitchOpen: true });
    });
    const input = screen.getByTestId("quick-switcher-input");
    fireEvent.change(input, { target: { value: "zzzz" } });
    expect(screen.getByText("No matching agents")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useStore.getState().activePane).toBeNull();
    expect(useStore.getState().quickSwitchOpen).toBe(true); // stays open
    unmount();
  });
});
