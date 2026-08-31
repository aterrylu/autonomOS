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
    capWindow: null,
    toggle,
    ...partial,
  });
  return toggle;
}

beforeEach(() => mockHook.mockReset());

describe("UsageQueueButton", () => {
  it("renders nothing when the account is not capped", () => {
    setHook({ capped: false });
    const { container } = render(
      <UsageQueueButton sessionId="s1" provider="claude-code" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders an off switch when capped and disarmed", () => {
    setHook({ capped: true, isArmed: false });
    render(<UsageQueueButton sessionId="s1" provider="claude-code" />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).toHaveTextContent("Auto-Enter when limit resets");
    expect(sw).toHaveTextContent("Type in the terminal to queue");
  });

  it("names the capping window so the button never contradicts the status bar", () => {
    // The bar shows only 5h/7d; when a per-model weekly caps, this label is
    // the user's only clue why the button appeared at "87%".
    setHook({ capped: true, isArmed: false, capWindow: "Sonnet 7d" });
    render(<UsageQueueButton sessionId="s1" provider="claude-code" />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveTextContent("Sonnet 7d at limit — type to queue");
    expect(sw.title).toMatch(/Sonnet 7d limit/);
  });

  it("shows the reset ETA when armed with a future reset", () => {
    const resetsAt = new Date(
      Date.now() + 2 * 3_600_000 + 13 * 60_000,
    ).toISOString();
    setHook({ capped: true, isArmed: true, resetsAt });
    render(<UsageQueueButton sessionId="s1" provider="claude-code" />);
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "true");
    // timeUntilReset → "2h 13m"; the subtitle reads "Sends in ~2h 13m".
    expect(sw.textContent).toMatch(/Sends in ~2h/);
  });

  it("falls back to 'Sends at reset' when armed without a known reset", () => {
    setHook({ capped: true, isArmed: true, resetsAt: null });
    render(<UsageQueueButton sessionId="s1" provider="claude-code" />);
    expect(screen.getByRole("switch")).toHaveTextContent("Sends at reset");
  });

  it("toggles when clicked", () => {
    const toggle = setHook({ capped: true, isArmed: false });
    render(<UsageQueueButton sessionId="s1" provider="claude-code" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("wears the SHARED overlay surface + glow, but KEEPS its accent state border", () => {
    // The E treatment is a family trait (elevation + glow), shared with the
    // Incoming-messages overlay via the same --overlay-* tokens. The border is
    // NOT swapped: its color still encodes armed/off state (the #340 contract),
    // so a shared restyle must not neutralize it.
    setHook({ capped: true, isArmed: false });
    render(<UsageQueueButton sessionId="s1" provider="claude-code" />);
    const panel = screen.getByTestId("usage-queue-overlay");
    expect(panel.style.background).toBe("var(--overlay-surface)");
    expect(panel.style.boxShadow).toBe("var(--overlay-glow)");
    // Off → yellow accent border preserved (state signal, not the hairline).
    // jsdom normalizes the hex to rgb().
    expect(panel.style.borderColor).toBe("rgb(230, 180, 80)");
    expect(panel.style.borderWidth).toBe("1.5px");
  });
});
