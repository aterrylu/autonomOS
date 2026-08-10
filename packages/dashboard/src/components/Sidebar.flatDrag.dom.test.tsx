// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * DOM-level drag WIRING for flat-view reorder. The reorder math is covered by
 * the reorderFlat unit tests; here we fire synthetic HTML5 drag events on the
 * rendered rows to verify handleDragStart→handleDragOver→handleDrop→reorderFlat
 * is wired with the correct section + indices, and that a cross-section drop is
 * a no-op (the section-clamping guard).
 */

const AGENT_IDS = ["a", "b", "c"];

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

function stubFetch(ids: string[]) {
  const agents = ids.map((id) => ({
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    createdAt: 1,
    updatedAt: 1,
  }));
  // Real `Response` objects — the api client reads the body via `res.text()`.
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      let body: unknown = {};
      if (u.includes("/api/agents") && !u.includes("/tree")) body = agents;
      else if (u.includes("/api/agents") || u.includes("/api/projects"))
        body = [];
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }),
  );
}

/** A synthetic dataTransfer good enough for the drag handlers. */
function makeDataTransfer() {
  const store: Record<string, string> = {};
  return {
    setData: (k: string, v: string) => {
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? "",
    effectAllowed: "",
    dropEffect: "",
  };
}

/** The draggable row element for an agent (the role=button ancestor). */
function row(name: string): HTMLElement {
  const el = screen.getByText(name).closest('[role="button"]');
  if (!el) throw new Error(`row not found for ${name}`);
  return el as HTMLElement;
}

function renderSidebar() {
  return render(<Sidebar />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("flat-view drag wiring", () => {
  it("reorders within the unpinned section via drag events", () => {
    stubFetch(AGENT_IDS);
    useStore.setState({
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      sessions: AGENT_IDS.map(sess),
      exitedSessions: [],
      agentStatuses: {},
      pinnedOrder: [],
      unpinnedOrder: ["a", "b", "c"],
    });
    renderSidebar();

    const dt = makeDataTransfer();
    // Drag 'a' (idx 0) onto 'c' (idx 2).
    fireEvent.dragStart(row("a"), { dataTransfer: dt });
    fireEvent.dragOver(row("c"), { dataTransfer: dt });
    fireEvent.drop(row("c"), { dataTransfer: dt });

    expect(useStore.getState().unpinnedOrder).toEqual(["b", "c", "a"]);
    expect(useStore.getState().pinnedOrder).toEqual([]);
  });

  it("ignores a cross-section drop (pinned ↔ unpinned)", () => {
    stubFetch(AGENT_IDS);
    useStore.setState({
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      sessions: AGENT_IDS.map(sess),
      exitedSessions: [],
      agentStatuses: {},
      pinnedOrder: ["a"],
      unpinnedOrder: ["b", "c"],
    });
    renderSidebar();

    const dt = makeDataTransfer();
    // Start dragging 'b' (unpinned) and drop onto 'a' (pinned) — must be a no-op.
    fireEvent.dragStart(row("b"), { dataTransfer: dt });
    fireEvent.dragOver(row("a"), { dataTransfer: dt });
    fireEvent.drop(row("a"), { dataTransfer: dt });

    expect(useStore.getState().pinnedOrder).toEqual(["a"]);
    expect(useStore.getState().unpinnedOrder).toEqual(["b", "c"]);
  });

  it("reorders within the pinned section without touching unpinned", () => {
    stubFetch(AGENT_IDS);
    useStore.setState({
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      sessions: AGENT_IDS.map(sess),
      exitedSessions: [],
      agentStatuses: {},
      pinnedOrder: ["a", "b"],
      unpinnedOrder: ["c"],
    });
    renderSidebar();

    const dt = makeDataTransfer();
    // Drag 'b' (pinned idx 1) onto 'a' (pinned idx 0).
    fireEvent.dragStart(row("b"), { dataTransfer: dt });
    fireEvent.dragOver(row("a"), { dataTransfer: dt });
    fireEvent.drop(row("a"), { dataTransfer: dt });

    expect(useStore.getState().pinnedOrder).toEqual(["b", "a"]);
    expect(useStore.getState().unpinnedOrder).toEqual(["c"]);
  });
});
