// @vitest-environment jsdom
import type { HandoffQueueItem } from "@autonomos/core";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { HandoffOverlay } from "./HandoffOverlay";

// Mock the API surface the overlay drives.
const queueList = vi.fn();
const queueSend = vi.fn();
const queueSendAll = vi.fn();
const queueDiscard = vi.fn();
const queueDiscardAll = vi.fn();
vi.mock("../api/agents", () => ({
  agentsApi: {
    queueList: (...a: unknown[]) => queueList(...a),
    queueSend: (...a: unknown[]) => queueSend(...a),
    queueSendAll: (...a: unknown[]) => queueSendAll(...a),
    queueDiscard: (...a: unknown[]) => queueDiscard(...a),
    queueDiscardAll: (...a: unknown[]) => queueDiscardAll(...a),
  },
}));

const ID = "gigi";
function item(
  id: string,
  from: string,
  message: string,
  fromUri?: string,
): HandoffQueueItem {
  return { id, from, message, enqueuedAt: 1, ...(fromUri ? { fromUri } : {}) };
}
function setCount(n: number) {
  useStore.setState({
    sessions: [
      { id: ID, name: "Gigi", status: "running", pendingHandoffCount: n },
    ] as never,
  });
}

beforeEach(() => {
  queueList.mockResolvedValue({ items: [] });
  queueSend.mockResolvedValue({ ok: true });
  queueSendAll.mockResolvedValue({ ok: true, remaining: 0 });
  queueDiscard.mockResolvedValue({ ok: true });
  queueDiscardAll.mockResolvedValue({ ok: true, cleared: 0 });
});
afterEach(() => {
  vi.clearAllMocks();
  useStore.setState({ sessions: [] });
});

describe("HandoffOverlay", () => {
  it("auto-hides at count 0 and fetches ONLY on the real 0→N transition (the #340 trap)", async () => {
    setCount(0);
    queueList.mockResolvedValue({
      items: [item("a", "TeamLead", "review this")],
    });
    render(<HandoffOverlay sessionId={ID} />);

    // Hidden, and NOTHING fetched while the queue is empty.
    expect(screen.queryByTestId("handoff-overlay")).toBeNull();
    expect(queueList).not.toHaveBeenCalled();

    // The REAL hidden→shown transition (a message arrives): the count-keyed
    // effect must fire the fetch NOW — a []-deps effect would render the overlay
    // but never load the list.
    act(() => setCount(1));
    await waitFor(() => expect(queueList).toHaveBeenCalledWith(ID));
    expect(await screen.findByTestId("handoff-overlay")).toBeTruthy();
    expect(screen.getByText("TeamLead")).toBeTruthy();
    expect(screen.getByText("review this")).toBeTruthy();
  });

  it("hides again when the count returns to 0", async () => {
    setCount(1);
    render(<HandoffOverlay sessionId={ID} />);
    expect(await screen.findByTestId("handoff-overlay")).toBeTruthy();
    act(() => setCount(0));
    await waitFor(() =>
      expect(screen.queryByTestId("handoff-overlay")).toBeNull(),
    );
  });

  it("Deliver sends one item and marks it delivering", async () => {
    setCount(1);
    queueList.mockResolvedValue({
      items: [item("a", "TeamLead", "review this")],
    });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("review this");

    fireEvent.click(screen.getByRole("button", { name: "Deliver" }));
    await waitFor(() => expect(queueSend).toHaveBeenCalledWith(ID, "a"));
    expect(await screen.findByTestId("handoff-sending")).toBeTruthy();
  });

  it("Discard removes one item immediately", async () => {
    setCount(1);
    queueList.mockResolvedValue({
      items: [item("a", "TeamLead", "review this")],
    });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("review this");

    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(queueDiscard).toHaveBeenCalledWith(ID, "a"));
    await waitFor(() => expect(screen.queryByText("review this")).toBeNull());
  });

  it("Deliver all sends the batch without a confirm", async () => {
    setCount(2);
    queueList.mockResolvedValue({
      items: [item("a", "x", "one"), item("b", "y", "two")],
    });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("one");

    fireEvent.click(screen.getByRole("button", { name: /Deliver all/ }));
    await waitFor(() => expect(queueSendAll).toHaveBeenCalledWith(ID));
  });

  it("Discard all requires an inline confirm", async () => {
    setCount(1);
    queueList.mockResolvedValue({ items: [item("a", "x", "one")] });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("one");

    // First click only reveals the confirm — nothing cleared yet.
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    expect(queueDiscardAll).not.toHaveBeenCalled();
    expect(screen.getByText("Discard all?")).toBeTruthy();

    // Confirm → clears.
    fireEvent.click(screen.getByRole("button", { name: "Discard all" }));
    await waitFor(() => expect(queueDiscardAll).toHaveBeenCalledWith(ID));
  });

  // The drag header is a real <button>; the drag hook .focus()es it
  // programmatically, which fools the browser's :focus-visible heuristic into
  // painting a ring on a MOUSE drag (Terry's cosmetic bug). We track modality
  // ourselves — these pin both halves of ":focus-visible semantics".
  it("does NOT paint a focus ring when the header is focused via a pointer drag", async () => {
    setCount(1);
    queueList.mockResolvedValue({ items: [item("a", "x", "one")] });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("one");
    const handle = screen.getByTestId("handoff-drag-handle");

    // A drag: pointerdown flags the imminent programmatic focus as pointer-
    // origin, so the focus it triggers must leave the ring suppressed.
    // (Assert the longhand — jsdom re-serializes the `outline` shorthand.)
    fireEvent.pointerDown(handle, { pointerId: 1 });
    act(() => handle.focus());
    expect(handle.style.outlineStyle).toBe("none");
  });

  it("DOES paint the on-brand ring for keyboard focus (a11y preserved)", async () => {
    setCount(1);
    queueList.mockResolvedValue({ items: [item("a", "x", "one")] });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("one");
    const handle = screen.getByTestId("handoff-drag-handle");

    // A keyboard focus (Tab) has no pointer flag set → the ring shows so the
    // arrow-key nudge affordance stays discoverable.
    act(() => fireEvent.focus(handle));
    expect(handle.style.outlineStyle).toBe("solid");
    expect(handle.style.outlineWidth).toBe("2px");

    // And an arrow nudge re-earns the ring even if focus came from a drag.
    fireEvent.pointerDown(handle, { pointerId: 1 });
    act(() => handle.focus()); // pointer-origin → suppressed
    expect(handle.style.outlineStyle).toBe("none");
    act(() => fireEvent.keyDown(handle, { key: "ArrowLeft" }));
    expect(handle.style.outlineStyle).toBe("solid");
  });

  it("distinguishes a schedule sender (chip + stripped name) from an agent (plain name)", async () => {
    // The half Terry actually looked at — pin it (nox). A schedule row shows a
    // "Schedule" chip + the scheme-stripped name; an agent row shows just the
    // name with no chip.
    setCount(2);
    queueList.mockResolvedValue({
      items: [
        item(
          "s",
          "Schedule review-request",
          "run it",
          "schedule://review-request",
        ),
        item("a", "Dispatcher", "heads up", "agent://Dispatcher"),
      ],
    });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("run it");
    // Exactly one "Schedule" chip, and it labels the stripped schedule name.
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(screen.getByText("review-request")).toBeTruthy();
    // The agent row renders its plain name and NO chip of its own.
    expect(screen.getByText("Dispatcher")).toBeTruthy();
    expect(screen.getAllByText("Schedule")).toHaveLength(1);
  });

  it("wears the SHARED floating-overlay E treatment (surface + hairline + glow tokens)", async () => {
    setCount(1);
    queueList.mockResolvedValue({ items: [item("a", "x", "one")] });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("one");
    const panel = screen.getByTestId("handoff-overlay");
    // References the shared tokens (index.css --overlay-*) — NOT copy-pasted
    // literals — so both floating overlays stay one family.
    expect(panel.style.background).toBe("var(--overlay-surface)");
    expect(panel.style.boxShadow).toBe("var(--overlay-glow)");
    expect(panel.style.border).toContain("var(--overlay-hairline)");
  });
});
