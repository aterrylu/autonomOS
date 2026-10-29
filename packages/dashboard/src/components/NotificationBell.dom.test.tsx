// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { THEMES, type ThemeName, useStore } from "../store";
import { NotificationBell } from "./NotificationBell";

// The panel fetches /api/hooks/notifications on mount. Stub it so the test is
// hermetic (no real network) and deterministic — we only care about the bell's
// toggle behavior, not the panel's data. A real `Response` (not an `{ ok, json }`
// duck type) because the api client reads the body via `res.text()`.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ notifications: [], totalUnread: 0 }), {
          status: 200,
        }),
      ),
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

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.replace("#", ""), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function toHex(rgb: string): string {
  const m = /rgb\((\d+), (\d+), (\d+)\)/.exec(rgb);
  if (!m) return rgb;
  return `#${m
    .slice(1, 4)
    .map((v) => Number(v).toString(16).padStart(2, "0"))
    .join("")}`;
}

describe("the bell is visible on every theme (#513)", () => {
  for (const theme of Object.keys(THEMES) as ThemeName[]) {
    it(`${theme}: the bell's colour stands out from the status bar (≥ 3:1)`, () => {
      useStore.setState({ theme, notificationCounts: {} });
      render(<NotificationBell />);
      const button = screen.getByRole("button", { name: /notifications/i });
      const color = toHex(button.style.color);
      expect(color).toBe(THEMES[theme].page.statusFg.toLowerCase());
      // 3:1 is WCAG's minimum for a meaningful icon.
      expect(contrast(color, THEMES[theme].page.bg)).toBeGreaterThanOrEqual(3);
    });
  }
});
