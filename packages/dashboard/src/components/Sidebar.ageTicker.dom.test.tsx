// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { NOW_TICK_MS } from "../hooks/useNow";
import { type SessionInfo, useStore } from "../store";
import { RECENCY_OPACITY_DARK } from "./recency";
import { Sidebar } from "./Sidebar";

// Count row-body renders: SessionRowBody calls useNow() exactly once per render.
const nowCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("../hooks/useNow", async (importActual) => {
  const actual = await importActual<typeof import("../hooks/useNow")>();
  return {
    ...actual,
    useNow: () => {
      nowCalls.n++;
      return actual.useNow();
    },
  };
});

/**
 * The row body is memoized, so it no longer re-renders when the sidebar does.
 * Its age text AND its recency fade bucket must still advance: they read the
 * shared useNow() clock. (Before, ages only advanced because an unrelated 30s
 * projects poll happened to re-render the sidebar.)
 */

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 25, 12, 0, 0);

function sess(id: string, lastActivityAt: number): SessionInfo {
  return {
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    claudeSessionId: id,
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    lastActivityAt,
  } as SessionInfo;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("[]", { status: 200 }))),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seed(sessions: SessionInfo[]) {
  useStore.setState({
    sidebarViewMode: "flat",
    sidebarViewModeExplicit: true,
    sessions,
    exitedSessions: [],
    agentStatuses: {},
    pinnedOrder: [],
    unpinnedOrder: sessions.map((s) => s.id),
    theme: "void",
  });
}

describe("Sidebar age labels advance on the shared clock (memoized row bodies)", () => {
  it("a row crossing the 1-day boundary re-fades from 'recent' to 'stale' on a tick", () => {
    // 15s short of a day: "recent" now; one 30s tick later it is "stale".
    const row = sess("aging-agent", T0 - (DAY - 15_000));
    useStore.setState({
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      sessions: [row],
      exitedSessions: [],
      agentStatuses: {},
      pinnedOrder: [],
      unpinnedOrder: ["aging-agent"],
      theme: "void",
    });
    render(<Sidebar />);
    const before = screen.getByText("23h");
    expect(before).toHaveStyle({
      opacity: String(RECENCY_OPACITY_DARK.recent),
    });

    act(() => {
      vi.advanceTimersByTime(NOW_TICK_MS);
    });

    // Same row, no store update: the ticker alone moved it across the boundary.
    const after = screen.getByText("1d");
    expect(after).toHaveStyle({ opacity: String(RECENCY_OPACITY_DARK.stale) });
  });

  it("a row that just became active reads fresh, though the clock is a tick behind", () => {
    seed([sess("busy-agent", T0 - 2 * 3_600_000)]);
    render(<Sidebar />);
    expect(screen.getByText("2h")).toBeTruthy();

    // 20s pass with NO tick (the shared clock still says T0), then activity
    // lands: lastActive is now AHEAD of the clock. Unclamped, that negative age
    // buckets as "recent" and paints the gray statusFg instead of the fg.
    vi.setSystemTime(T0 + 20_000);
    act(() => {
      useStore.setState({
        sessions: [sess("busy-agent", Date.now())],
      });
    });
    const label = screen.getByText("now");
    // void's page.fg #d4d4d4 — the "fresh" color
    expect(label).toHaveStyle({ color: "rgb(212, 212, 212)" });
  });

  it("a status change for one agent re-renders only THAT row's body", () => {
    seed([sess("agent-a", T0 - 60_000), sess("agent-b", T0 - 60_000)]);
    render(<Sidebar />);
    const before = nowCalls.n;
    act(() => {
      useStore.setState((st) => ({
        agentStatuses: {
          ...st.agentStatuses,
          "agent-a": { status: "working" },
        },
      }));
    });
    expect(nowCalls.n - before).toBe(1);
  });
});
