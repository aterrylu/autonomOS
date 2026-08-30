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
function item(id: string, from: string, message: string): HandoffQueueItem {
  return { id, from, message, enqueuedAt: 1 };
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

  it("Send delivers one item and marks it delivering", async () => {
    setCount(1);
    queueList.mockResolvedValue({
      items: [item("a", "TeamLead", "review this")],
    });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("review this");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
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

  it("Send all delivers without a confirm", async () => {
    setCount(2);
    queueList.mockResolvedValue({
      items: [item("a", "x", "one"), item("b", "y", "two")],
    });
    render(<HandoffOverlay sessionId={ID} />);
    await screen.findByText("one");

    fireEvent.click(screen.getByRole("button", { name: /Send all/ }));
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
});
