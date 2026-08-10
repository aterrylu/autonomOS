// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test/setup-dom";
import { applyStatusSnapshot, useStore } from "./store";

/**
 * `applyStatusSnapshot` — the `GET /api/hooks` applier.
 *
 * It moved out of the store's `fetchNotifications` when that action switched to
 * refreshing the shared `statusPoll`, so it now runs from TWO callers (the
 * store action and the Sidebar's poll subscription). The desktop notification
 * for `needs_input` rides on it, and its edge-firing guard is what keeps a
 * still-needs_input agent from re-notifying on every applied snapshot — which
 * matters more now that the poll can apply a snapshot from either caller.
 */

/** Captures `new Notification(title, opts)` calls. */
const notifications: Array<{ title: string; body?: string }> = [];

class MockNotification {
  static permission = "granted";
  constructor(title: string, opts?: { body?: string }) {
    notifications.push({ title, body: opts?.body });
  }
}

beforeEach(() => {
  notifications.length = 0;
  vi.stubGlobal("Notification", MockNotification);
  // The notification only fires while the tab is NOT focused.
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  useStore.setState({
    sessions: [
      {
        id: "a-1",
        name: "Scout",
        status: "running",
        workingDirectory: "/tmp",
        provider: "claude",
        claudeSessionId: "a-1",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    agentStatuses: {},
    notificationCounts: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const snapshot = (status: string, unread = 0) => ({
  "a-1": {
    status: { status, lastEvent: "Stop", updatedAt: 1 },
    unread,
  },
});

describe("applyStatusSnapshot", () => {
  it("notifies by agent NAME when an agent transitions into needs_input", () => {
    applyStatusSnapshot(snapshot("working") as never);
    expect(notifications).toEqual([]);

    applyStatusSnapshot(snapshot("needs_input") as never);
    expect(notifications).toEqual([
      { title: "autonomOS — Scout", body: "Needs your input" },
    ]);
  });

  it("does not re-notify while the agent STAYS in needs_input", () => {
    applyStatusSnapshot(snapshot("needs_input") as never);
    applyStatusSnapshot(snapshot("needs_input") as never);
    applyStatusSnapshot(snapshot("needs_input") as never);
    expect(notifications).toHaveLength(1);
  });

  it("notifies again after the agent leaves and re-enters needs_input", () => {
    applyStatusSnapshot(snapshot("needs_input") as never);
    applyStatusSnapshot(snapshot("working") as never);
    applyStatusSnapshot(snapshot("needs_input") as never);
    expect(notifications).toHaveLength(2);
  });

  it("stays silent while the tab is focused", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    applyStatusSnapshot(snapshot("needs_input") as never);
    expect(notifications).toEqual([]);
    // …but the status still lands in the store.
    expect(useStore.getState().agentStatuses["a-1"].status).toBe("needs_input");
  });

  it("commits unread counts and statuses to the store", () => {
    applyStatusSnapshot(snapshot("working", 3) as never);
    expect(useStore.getState().notificationCounts).toEqual({ "a-1": 3 });
    expect(useStore.getState().agentStatuses["a-1"].status).toBe("working");
  });
});
