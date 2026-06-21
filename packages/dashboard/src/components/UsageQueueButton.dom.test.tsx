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
    capped: true,
    resetsAt: null,
    toggle,
    ...partial,
  });
  return toggle;
}

beforeEach(() => mockHook.mockReset());

describe("UsageQueueButton", () => {
  it("renders nothing when the account is not capped", () => {
    setHook({ capped: false });
    const { container } = render(<UsageQueueButton sessionId="s1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an off switch when capped and disarmed", () => {
    setHook({ capped: true, isArmed: false });
    render(<UsageQueueButton sessionId="s1" />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveTextContent("Auto-Enter when limit resets");
    expect(sw).toHaveTextContent("Type in the terminal to queue");
  });

  it("shows the reset ETA when armed with a future reset", () => {
    const resetsAt = new Date(
      Date.now() + 2 * 3_600_000 + 13 * 60_000,
    ).toISOString();
    setHook({ capped: true, isArmed: true, resetsAt });
    render(<UsageQueueButton sessionId="s1" />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    // timeUntilReset → "2h 13m"; the subtitle reads "Sends in ~2h 13m".
    expect(sw.textContent).toMatch(/Sends in ~2h/);
  });

  it("falls back to 'Sends at reset' when armed without a known reset", () => {
    setHook({ capped: true, isArmed: true, resetsAt: null });
    render(<UsageQueueButton sessionId="s1" />);
    expect(screen.getByRole("switch")).toHaveTextContent("Sends at reset");
  });

  it("toggles when clicked", () => {
    const toggle = setHook({ capped: true, isArmed: false });
    render(<UsageQueueButton sessionId="s1" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(toggle).toHaveBeenCalledTimes(1);
  });
});
