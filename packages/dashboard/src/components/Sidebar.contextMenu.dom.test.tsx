// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * Right-click wiring (ADR-093): a contextmenu on a running SessionRow opens the
 * agent menu at the pointer, scoped to the row (the handler lives on the row,
 * never on the document — xterm owns right-click in terminal panes). Proves the
 * prop threading from Sidebar → SessionRow and the escape-stack dismissal.
 */
vi.mock("../hooks/useTerminal", () => ({ focusTerminal: vi.fn() }));

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
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      let body: unknown = {};
      if (u.includes("/api/agents") && !u.includes("/tree"))
        body = AGENTS_PAYLOAD;
      else if (u.includes("/api/agents") || u.includes("/api/projects"))
        body = [];
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }),
  );
  useStore.setState({
    sidebarViewMode: "flat",
    sidebarViewModeExplicit: true,
    sessions: [sess("alpha")],
    exitedSessions: [],
    agentStatuses: {},
    pinnedOrder: [],
    unpinnedOrder: ["alpha"],
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("Sidebar — row context menu wiring", () => {
  it("right-click on a row opens the running menu; Escape closes it", () => {
    render(<Sidebar />);
    // No menu until the row is right-clicked.
    expect(screen.queryByRole("menu")).toBeNull();

    const row = document.querySelector('[data-session-id="alpha"]');
    expect(row).toBeTruthy();
    fireEvent.contextMenu(row as Element, { clientX: 120, clientY: 80 });

    const menu = within(screen.getByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Kill" })).toBeTruthy();
    expect(menu.getByRole("menuitem", { name: "Delete…" })).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
