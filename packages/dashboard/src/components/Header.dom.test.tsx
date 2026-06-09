// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { Header } from "./Header";

/**
 * Header — the top bar. Renders the product title and a sidebar-toggle button
 * wired to the real store action `toggleSidebar`. We assert the title renders
 * and that clicking the toggle flips `sidebarOpen` in the store.
 */
describe("Header", () => {
  beforeEach(() => {
    useStore.setState({ sidebarOpen: true });
  });

  it("renders the product title", () => {
    render(<Header />);
    expect(
      screen.getByRole("heading", { name: "autonomOS" }),
    ).toBeInTheDocument();
  });

  it("toggles sidebarOpen in the store when the toggle is clicked", async () => {
    const user = userEvent.setup();
    render(<Header />);
    // The toggle's accessible name is the ☰ glyph; query by its title instead.
    const toggle = screen.getByTitle("Toggle sidebar");

    expect(useStore.getState().sidebarOpen).toBe(true);
    await user.click(toggle);
    expect(useStore.getState().sidebarOpen).toBe(false);
    await user.click(toggle);
    expect(useStore.getState().sidebarOpen).toBe(true);
  });
});
