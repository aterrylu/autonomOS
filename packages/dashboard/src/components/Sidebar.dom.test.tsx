// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { DragProvider } from "../layout/DragContext";
import { useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * Sidebar render behavior for the default-view + exited-removal changes.
 *
 * Sidebar fetches /api/agents/tree (org chart), /api/agents, and
 * /api/notifications on mount — we stub fetch to return empty payloads so the
 * component reaches a stable rendered state. It also requires a DragProvider
 * (useDragContext throws otherwise), matching how App.tsx wraps it.
 */

function stubEmptyFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      // /api/agents, /api/agents/tree and /api/projects return arrays;
      // /api/hooks (notifications) returns an object map.
      const u = typeof url === "string" ? url : "";
      const body =
        u.includes("/api/agents") || u.includes("/api/projects") ? [] : {};
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
  // Reset the persisted view fields to their built defaults so one test's
  // explicit choice can't leak into the next via the shared store singleton.
  useStore.setState({
    sessions: [],
    exitedSessions: [],
    agentStatuses: {},
    sidebarViewMode: "hierarchy",
    sidebarViewModeExplicit: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sidebar — default view", () => {
  it("renders the hierarchy view by default (toggle offers to switch to flat)", () => {
    renderSidebar();
    // In hierarchy mode the view toggle's tooltip invites switching to flat;
    // its presence proves the default rendered view is hierarchy, not flat.
    expect(screen.getByTitle("Switch to flat view")).toBeInTheDocument();
    expect(
      screen.queryByTitle("Switch to hierarchy view"),
    ).not.toBeInTheDocument();
  });
});

describe("Sidebar — exited agents removed", () => {
  it("renders no show-stopped eye toggle", () => {
    renderSidebar();
    // The old eye toggle's tooltip always contained "stopped"
    // (e.g. "Show 2 recently stopped" / "Hide stopped agents").
    expect(screen.queryByTitle(/stopped/i)).not.toBeInTheDocument();
  });

  it("does not surface the eye toggle even when stopped agents exist", () => {
    // Seed an exited session: previously this made the eye toggle appear
    // (it was gated on exitedSessions.length > 0). It must no longer.
    useStore.setState({
      exitedSessions: [
        {
          id: "dead-1",
          name: "Ghost",
          status: "exited",
          workingDirectory: "/tmp",
          provider: "claude",
          claudeSessionId: "dead-1",
          createdAt: 1,
          updatedAt: 2,
          exitedAt: 2,
        },
      ],
    });
    renderSidebar();
    expect(screen.queryByTitle(/stopped/i)).not.toBeInTheDocument();
    // The exited agent's name must not appear anywhere in the sidebar.
    expect(screen.queryByText("Ghost")).not.toBeInTheDocument();
  });
});
