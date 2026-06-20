// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";

vi.mock("../hooks/useUsageQueue", () => ({ useUsageQueue: vi.fn() }));

import { useUsageQueue } from "../hooks/useUsageQueue";
import { UsageQueueButton } from "./UsageQueueButton";

const mockHook = vi.mocked(useUsageQueue);

function setHook(partial: Partial<ReturnType<typeof useUsageQueue>>) {
  const toggle = vi.fn(async () => {});
  mockHook.mockReturnValue({
    isArmed: false,
    blocked: false,
    resetsAt: null,
    toggle,
    ...partial,
  });
  return toggle;
}

beforeEach(() => mockHook.mockReset());

describe("UsageQueueButton", () => {
  it("renders a faint, unlabeled button when disarmed", () => {
    setHook({ isArmed: false });
    render(<UsageQueueButton sessionId="s1" />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    // No status text when disarmed — just the hourglass glyph.
    expect(btn).not.toHaveTextContent("queued");
    expect(btn.querySelector("svg")).not.toBeNull();
  });

  it("shows 'queued' when armed but not yet blocked", () => {
    setHook({ isArmed: true, blocked: false });
    render(<UsageQueueButton sessionId="s1" />);
    const btn = screen.getByRole("button");
    expect(btn).toHaveAttribute("aria-pressed", "true");
    expect(btn).toHaveTextContent("queued");
  });

  it("shows an ETA when armed AND blocked with a future reset", () => {
    const resetsAt = new Date(
      Date.now() + 2 * 3_600_000 + 13 * 60_000,
    ).toISOString();
    setHook({ isArmed: true, blocked: true, resetsAt });
    render(<UsageQueueButton sessionId="s1" />);
    // timeUntilReset → "2h 13m"; the button prefixes "~".
    expect(screen.getByRole("button").textContent).toMatch(/~2h/);
  });

  it("falls back to 'queued' when armed+blocked but the reset is unknown", () => {
    setHook({ isArmed: true, blocked: true, resetsAt: null });
    render(<UsageQueueButton sessionId="s1" />);
    expect(screen.getByRole("button")).toHaveTextContent("queued");
  });

  it("calls toggle when clicked", () => {
    const toggle = setHook({ isArmed: false });
    render(<UsageQueueButton sessionId="s1" />);
    fireEvent.click(screen.getByRole("button"));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("describes the queued behavior in its accessible label", () => {
    setHook({ isArmed: false });
    render(<UsageQueueButton sessionId="s1" />);
    expect(screen.getByRole("button").getAttribute("aria-label")).toMatch(
      /usage limit/i,
    );
  });
});
