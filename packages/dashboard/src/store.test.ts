import { beforeEach, describe, expect, it } from "vitest";
import { type ActivePane, useStore } from "./store";

// ── Helpers ──────────────────────────────────────────────────────────

const sessionPane = (id: string): ActivePane => ({ type: "session", id });

/** Reset store to a clean state before each test */
function resetStore() {
  useStore.setState({
    activePane: null,
    status: "disconnected",
    sessions: [],
    projects: [],
    sidebarOpen: true,
    permissionMode: "bypass",
    pinnedOrder: [],
    unpinnedOrder: [],
    previewPanes: [],
    visiblePaneIds: [],
    dvWorkspaces: {},
    dvPaneWorkspace: {},
  });
}

beforeEach(() => {
  resetStore();
});

// ── switchPane (dockview — the only engine, ADR-047) ─────────────────
// DockviewLayout owns the pane topology; the store just tracks `activePane`.
// Clicking is pure navigation — it opens the pane SOLO and never builds a
// split. Composition is drag-only (exercised end-to-end in Playwright, not here).
describe("switchPane", () => {
  it("opens a pane solo: sets activePane", () => {
    useStore.getState().switchPane(sessionPane("s1"));
    expect(useStore.getState().activePane).toEqual(sessionPane("s1"));
  });

  it("clicking another agent navigates solo", () => {
    useStore.getState().switchPane(sessionPane("s1"));
    useStore.getState().switchPane(sessionPane("s2"));
    expect(useStore.getState().activePane).toEqual(sessionPane("s2"));
  });

  it("openOrgChart routes through switchPane and opens the view solo", () => {
    useStore.getState().switchPane(sessionPane("s1"));
    useStore.getState().openOrgChart();

    expect(useStore.getState().activePane).toEqual({
      type: "orgchart",
      id: "orgchart",
    });
  });

  it("switchPane(null) clears activePane", () => {
    useStore.getState().switchPane(sessionPane("s1"));
    useStore.getState().switchPane(null);
    expect(useStore.getState().activePane).toBeNull();
  });
});

describe("agentIconStyle", () => {
  it("defaults to the provider style", () => {
    expect(useStore.getState().agentIconStyle).toBe("provider");
  });

  it("setAgentIconStyle switches between provider and status", () => {
    useStore.getState().setAgentIconStyle("status");
    expect(useStore.getState().agentIconStyle).toBe("status");
    useStore.getState().setAgentIconStyle("provider");
    expect(useStore.getState().agentIconStyle).toBe("provider");
  });
});
