// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { NotificationBell } from "./NotificationBell";

// The panel fetches /api/hooks/notifications on mount. Stub it so the test is
// hermetic (no real network) and deterministic — we only care about the bell's
// toggle behavior, not the panel's data.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ notifications: [], totalUnread: 0 }),
      } as Response),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * NotificationBell — reads `notificationCounts` from the Zustand store, shows a
 * "bell-dot" codicon when there are unread notifications (else a plain "bell"),
 * and toggles the NotificationPanel on click. We drive the real store via
 * `setState` (the same pattern store.test.ts uses) and assert behavior.
 */
describe("NotificationBell", () => {
  beforeEach(() => {
    useStore.setState({ notificationCounts: {} });
  });

  it("renders without unread notifications (plain bell, no panel)", () => {
    render(<NotificationBell />);
    const button = screen.getByRole("button", { name: /notifications/i });
    expect(button).toBeInTheDocument();
    // Panel is closed initially — no "Notifications" heading from the panel.
    expect(screen.queryByText(/no notifications/i)).not.toBeInTheDocument();
  });

  it("opens the notification panel on click and closes it via the panel's close button", async () => {
    const user = userEvent.setup();
    render(<NotificationBell />);
    const button = screen.getByRole("button", { name: /notifications/i });

    // Before the click there is exactly one button (the bell itself).
    expect(screen.getAllByRole("button")).toHaveLength(1);

    await user.click(button);
    // Panel is now mounted — its empty-state copy is visible.
    expect(
      await screen.findByText(/no notifications yet/i),
    ).toBeInTheDocument();

    // The panel's last button is its close (×) control; clicking it calls
    // onClose, unmounting the panel.
    const buttons = screen.getAllByRole("button");
    await user.click(buttons[buttons.length - 1]);
    expect(screen.queryByText(/no notifications yet/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("renders a different bell icon when there are unread notifications", () => {
    // Render each state as a fresh mount so each reads the current store value
    // directly (no reliance on a re-render flush). bell vs bell-dot are
    // distinct codicons → distinct path `d` geometry.
    const pathData = (c: HTMLElement) =>
      [...c.querySelectorAll("path")].map((p) => p.getAttribute("d"));

    useStore.setState({ notificationCounts: { "session-a": 3 } });
    const dot = render(<NotificationBell />);
    const dotPaths = pathData(dot.container);
    dot.unmount();

    useStore.setState({ notificationCounts: {} });
    const plain = render(<NotificationBell />);
    const plainPaths = pathData(plain.container);

    expect(dotPaths.length).toBeGreaterThan(0);
    expect(plainPaths.length).toBeGreaterThan(0);
    expect(dotPaths).not.toEqual(plainPaths);
  });
});
