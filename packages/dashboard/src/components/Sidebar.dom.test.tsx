// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { THEMES, useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * Sidebar render behavior for the default-view + exited-removal changes.
 *
 * Sidebar fetches /api/agents/tree (org chart), /api/agents, and
 * /api/notifications on mount — we stub fetch to return empty payloads so the
 * component reaches a stable rendered state.
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
  return render(<Sidebar />);
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
    theme: "void",
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

describe("Sidebar — env preset pill", () => {
  const running = {
    id: "a-1",
    name: "Kimi",
    status: "running" as const,
    workingDirectory: "/tmp/proj",
    provider: "claude" as const,
    claudeSessionId: "a-1",
    createdAt: 1,
    updatedAt: 2,
  };

  it("renders the pill highlighted at the far right of the bottom line", () => {
    useStore.setState({
      sessions: [{ ...running, envPreset: "kimi-k3" }],
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
      // Pin the theme: the store singleton may carry another test's (or a
      // persisted) theme, and the accent assertion below is per-theme.
      theme: "midnight",
      // Seed the transient status label the pill must sit AFTER — without it
      // the row renders no label and "last child" can't tell the two apart.
      agentStatuses: { "a-1": { status: "working" } },
    });
    renderSidebar();
    const pill = screen.getByTitle("Env preset: kimi-k3");
    expect(pill).toHaveTextContent("kimi-k3");
    // Highlight: the theme accent (midnight #e6b450), not the old faint grey.
    // Assert all three properties — background and border are built by hex
    // concatenation (`${accent}1f`), which CSS silently DROPS if the accent
    // ever stops being 6-digit hex; color alone would stay green through that.
    expect(pill).toHaveStyle({
      color: "rgb(230, 180, 80)",
      background: "rgba(230, 180, 80, 0.12)",
      border: "1px solid #e6b450",
    });
    // Placement: LAST child of the bottom line, to the right of BOTH the
    // repo/branch text and the transient status label — the position, not
    // just the styling, is the feature.
    expect(pill.nextElementSibling).toBeNull();
    expect(pill.previousElementSibling).toHaveTextContent("Working");
    expect(pill.parentElement?.textContent).toContain("proj");
  });

  it("renders no pill on rows without a preset", () => {
    useStore.setState({
      sessions: [running],
      sidebarViewMode: "flat",
      sidebarViewModeExplicit: true,
    });
    renderSidebar();
    expect(screen.getByText("Kimi")).toBeInTheDocument();
    expect(screen.queryByTitle(/^Env preset:/)).not.toBeInTheDocument();
  });

  it("every theme's accent is 6-digit hex (the pill and active-row ring append hex alpha bytes to it)", () => {
    // `${accent}1f` / `${accent}14` produce an invalid color — which CSS
    // silently ignores — for any other format. Red here beats a pill that
    // quietly loses its fill in one theme.
    for (const theme of Object.values(THEMES)) {
      expect(theme.terminal.yellow).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
