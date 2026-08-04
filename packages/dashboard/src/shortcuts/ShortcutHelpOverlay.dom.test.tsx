// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { closeTopEscape, hasEscapeCloser } from "./escapeStack";
import { SHORTCUTS } from "./registry";
import { ShortcutHelpOverlay } from "./ShortcutHelpOverlay";

/**
 * The cheatsheet overlay. The click test is the load-bearing one: closing is
 * driven by a backdrop-only target check rather than a stopPropagation handler
 * on the dialog, so a click INSIDE the dialog must not dismiss it.
 */
describe("ShortcutHelpOverlay", () => {
  afterEach(() => {
    useStore.setState({ shortcutHelpOpen: false });
  });

  it("renders nothing while closed", () => {
    useStore.setState({ shortcutHelpOpen: false });
    const { container } = render(<ShortcutHelpOverlay />);
    expect(container).toBeEmptyDOMElement();
  });

  it("registers on the escape stack while open, releases on close (ADR-065)", () => {
    useStore.setState({ shortcutHelpOpen: true });
    const { unmount } = render(<ShortcutHelpOverlay />);
    expect(hasEscapeCloser()).toBe(true);

    act(() => closeTopEscape());
    expect(useStore.getState().shortcutHelpOpen).toBe(false);
    expect(hasEscapeCloser()).toBe(false);
    unmount();
  });

  it("lists every registry shortcut when open", () => {
    useStore.setState({ shortcutHelpOpen: true });
    render(<ShortcutHelpOverlay />);
    for (const s of SHORTCUTS) {
      expect(screen.getByText(s.description)).toBeInTheDocument();
    }
  });

  it("closes on a backdrop click but not on a click inside the dialog", async () => {
    const user = userEvent.setup();
    useStore.setState({ shortcutHelpOpen: true });
    const { container } = render(<ShortcutHelpOverlay />);

    await user.click(screen.getByRole("dialog"));
    expect(useStore.getState().shortcutHelpOpen).toBe(true);

    const backdrop = container.firstElementChild as HTMLElement;
    await user.click(backdrop);
    expect(useStore.getState().shortcutHelpOpen).toBe(false);
  });
});
