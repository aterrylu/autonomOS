// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { DragProvider } from "../layout/DragContext";
import { type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * Flat-view pinning UI: the sidebar splits into a pinned section (top) and an
 * unpinned section (below) with a divider, and each agent row has a hover-reveal
 * pin/unpin button. We render the real Sidebar in flat mode with seeded store
 * state and assert the sections, divider, and pin/unpin behavior.
 */

function sess(id: string): SessionInfo {
  return {
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    claudeSessionId: id,
    createdAt: 1,
    updatedAt: 1,
  };
}

// /api/agents must return our two agents so the mount fetch (fetchSessions)
// keeps them live — otherwise it would prune the seeded order arrays. The org
// tree and projects return empty (flat view doesn't use the tree).
const AGENTS_PAYLOAD = [
  {
    id: "alpha",
    name: "alpha",
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "beta",
    name: "beta",
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    createdAt: 1,
    updatedAt: 1,
  },
];

function stubEmptyFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      let body: unknown = {};
      if (u.includes("/api/agents") && !u.includes("/tree")) {
        body = AGENTS_PAYLOAD;
      } else if (u.includes("/api/agents") || u.includes("/api/projects")) {
        body = [];
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      } as Response);
    }),
  );
}

function renderSidebar() {
  return render(
    <DragProvider>
      <Sidebar />
    </DragProvider>,
  );
}

beforeEach(() => {
  stubEmptyFetch();
  useStore.setState({
    sidebarViewMode: "flat", // force flat view (default is now hierarchy)
    sidebarViewModeExplicit: true,
    sessions: [sess("alpha"), sess("beta")],
    exitedSessions: [],
    agentStatuses: {},
    pinnedOrder: ["alpha"],
    unpinnedOrder: ["beta"],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sidebar flat view — pinned/unpinned sections", () => {
  it("renders the divider when a pinned agent exists", () => {
    renderSidebar();
    expect(screen.getByTestId("flat-section-divider")).toBeInTheDocument();
  });

  it("shows an Unpin button on the pinned agent and a Pin button on the unpinned agent", () => {
    renderSidebar();
    expect(screen.getByTitle("Unpin agent")).toBeInTheDocument();
    expect(screen.getByTitle("Pin agent")).toBeInTheDocument();
  });

  it("pinning the unpinned agent appends it to the bottom of pinned", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByTitle("Pin agent")); // beta
    expect(useStore.getState().pinnedOrder).toEqual(["alpha", "beta"]);
    expect(useStore.getState().unpinnedOrder).toEqual([]);
  });

  it("unpinning the pinned agent prepends it to the top of unpinned", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await user.click(screen.getByTitle("Unpin agent")); // alpha
    expect(useStore.getState().pinnedOrder).toEqual([]);
    expect(useStore.getState().unpinnedOrder).toEqual(["alpha", "beta"]);
  });

  it("hides the divider when nothing is pinned", () => {
    useStore.setState({ pinnedOrder: [], unpinnedOrder: ["alpha", "beta"] });
    renderSidebar();
    expect(
      screen.queryByTestId("flat-section-divider"),
    ).not.toBeInTheDocument();
  });

  it("hides the divider when everything is pinned (nothing below it)", () => {
    useStore.setState({ pinnedOrder: ["alpha", "beta"], unpinnedOrder: [] });
    renderSidebar();
    expect(
      screen.queryByTestId("flat-section-divider"),
    ).not.toBeInTheDocument();
  });
});
