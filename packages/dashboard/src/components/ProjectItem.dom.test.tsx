// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import type { ProjectInfo } from "../store";
import { THEMES, useStore } from "../store";
import { ProjectItem } from "./Sidebar";

/**
 * The Projects row mirrors a live agent row (ADR-098 gate pick). Three states,
 * distinguished only by the trailing slot (the same slot SessionRow uses for its
 * status label) — no archive dimming, no loud pills:
 *   live (ours + running)  → a subtle ↗ jump hint; click JUMPS to the live pane.
 *   stopped (ours + exited)→ a "Stopped" label; click resumes.
 *   external (unmanaged)   → a hover-revealed "Resume"; click resumes/adopts.
 * The row is keyed by CC/provider session id, not an agent id.
 */
const page = THEMES.midnight.page;

const PROJECT: ProjectInfo = {
  path: "/repo/autonomOS",
  name: "autonomOS",
  lastActive: 2_000,
  sessions: [
    // matches the live agent record below → LIVE
    {
      sessionId: "cc-live",
      provider: "claude-code",
      summary: "live session",
      lastModified: 1_000,
    },
    // no record match → EXTERNAL
    {
      sessionId: "cc-ext",
      provider: "claude-code",
      summary: "external session",
      lastModified: 1_000,
    },
    // managed + exited → STOPPED
    {
      sessionId: "cx-stop",
      provider: "codex",
      summary: "stopped session",
      lastModified: 1_000,
      isAutonomosAgent: true,
      autonomosStatus: "exited",
    },
  ],
};

function seed() {
  useStore.setState({
    // the live agent record the "cc-live" row resolves to
    sessions: [
      {
        id: "live-1",
        name: "LiveOne",
        claudeSessionId: "cc-live",
        status: "running",
        lastActivityAt: Date.now(),
        // biome-ignore lint/suspicious/noExplicitAny: partial SessionInfo
      } as any,
    ],
    exitedSessions: [],
    status: "idle",
    theme: "midnight",
    agentIconStyle: "provider",
    // The live feed the live row reads for its real status dot (Terry's #369
    // refinement) — "working" → the blue corner dot, not a blank circle.
    agentStatuses: { "live-1": { status: "working" } },
    expandedProjects: { "/repo/autonomOS": true },
    switchPane: vi.fn(),
    resumeSession: vi.fn().mockResolvedValue(undefined),
    createSession: vi.fn().mockResolvedValue(undefined),
    toggleProjectExpanded: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
  } as any);
}

function renderItem() {
  return render(
    <ProjectItem
      project={PROJECT}
      page={page}
      liveSessionIds={new Set(["cc-live"])}
      onAgentContextMenu={vi.fn()}
    />,
  );
}

beforeEach(seed);
afterEach(() => vi.clearAllMocks());

describe("ProjectItem — redesigned rows", () => {
  it("a LIVE row marks itself a jump link and JUMPS to the pane (not resume)", () => {
    renderItem();
    const row = screen.getByText("live session").closest("button");
    if (!row) throw new Error("no row");
    // Agent-row parity (ADR-098): no loud "Live" pill — the trailing slot holds a
    // subtle ↗ jump hint (labelled) and the whole row click jumps.
    expect(within(row).getByLabelText("Jump to the live agent")).toBeTruthy();
    fireEvent.click(row);
    expect(useStore.getState().switchPane).toHaveBeenCalledWith({
      type: "session",
      id: "live-1",
    });
    expect(useStore.getState().resumeSession).not.toHaveBeenCalled();
  });

  it("a LIVE row shows its REAL status dot from the live feed (#369 refinement)", () => {
    renderItem();
    const live = screen.getByText("live session").closest("button");
    if (!live) throw new Error("no row");
    // Seeded agentStatuses["live-1"] = "working" → the syncing corner badge,
    // aria-labelled "Working" (not the blank circle the coarse record gave).
    expect(within(live).getByLabelText("Working")).toBeTruthy();
  });

  it("a LIVE row still jumps while an unrelated spawn is in flight (isBusy gates resume only)", () => {
    useStore.setState({ status: "spawning..." });
    renderItem();
    const live = screen.getByText("live session").closest("button");
    if (!live) throw new Error("no row");
    fireEvent.click(live);
    expect(useStore.getState().switchPane).toHaveBeenCalledWith({
      type: "session",
      id: "live-1",
    });
    // …but the resume path IS still guarded while busy.
    const ext = screen.getByText("external session").closest("button");
    if (!ext) throw new Error("no row");
    fireEvent.click(ext);
    expect(useStore.getState().resumeSession).not.toHaveBeenCalled();
  });

  it("an EXTERNAL row resumes/adopts by its session id on click", () => {
    renderItem();
    const row = screen.getByText("external session").closest("button");
    if (!row) throw new Error("no row");
    fireEvent.click(row);
    expect(useStore.getState().resumeSession).toHaveBeenCalledWith(
      "cc-ext",
      "/repo/autonomOS",
      "external session",
      { isAutonomosAgent: undefined },
    );
    expect(useStore.getState().switchPane).not.toHaveBeenCalled();
  });

  it("a managed+exited row shows a Stopped indicator", () => {
    renderItem();
    const row = screen.getByText("stopped session").closest("button");
    if (!row) throw new Error("no row");
    expect(within(row).getByText("Stopped")).toBeTruthy();
  });

  it("grays out DEAD rows (external/stopped) but keeps LIVE rows full-strength (#369 refinement)", () => {
    renderItem();
    const live = screen.getByText("live session").closest("button");
    const ext = screen.getByText("external session").closest("button");
    const stop = screen.getByText("stopped session").closest("button");
    if (!live || !ext || !stop) throw new Error("rows missing");
    // Live = full-strength (no dim); dead = grayed (dimmed at rest, restored on
    // hover). The dim is on the TEXT column only — never the row — so the
    // provider mark always renders unaltered (brand policy; Terry's Codex report).
    const textCol = (row: HTMLElement) =>
      within(row)
        .getByText(/session$/)
        .closest("div.min-w-0") as HTMLElement;
    expect(textCol(live).className).not.toMatch(/opacity-60/);
    expect(textCol(ext).className).toMatch(/opacity-60/);
    expect(textCol(ext).className).toMatch(/group-hover\/row:opacity-100/);
    expect(textCol(stop).className).toMatch(/opacity-60/);
    for (const row of [live, ext, stop]) {
      expect(row.className).not.toMatch(/opacity-/);
      // No element between the row and the provider mark carries a dim.
      const mark = row.querySelector("svg[role='img']");
      if (!mark) throw new Error("provider mark missing");
      for (
        let el: Element | null = mark;
        el && el !== row;
        el = el.parentElement
      ) {
        expect((el as HTMLElement).className?.toString() ?? "").not.toMatch(
          /opacity-/,
        );
      }
    }
  });

  it("collapsing routes through the store, not per-mount state (bug #8)", () => {
    renderItem();
    fireEvent.click(screen.getByText("autonomOS"));
    expect(useStore.getState().toggleProjectExpanded).toHaveBeenCalledWith(
      "/repo/autonomOS",
    );
  });

  it("right edge (V1): count and quick-spawn '+' share one flush-right slot; '+' is inert until hover", () => {
    renderItem();
    const plus = screen.getByLabelText("New session in autonomOS");
    const header = screen.getByRole("button", { expanded: true });
    // The "+" is NOT nested in the disclosure toggle (a click on it must not
    // collapse the project) and sits in the SAME slot as the count.
    expect(header.contains(plus)).toBe(false);
    const slot = plus.parentElement;
    expect(slot?.textContent).toBe(`${PROJECT.sessions.length}+`);
    // At rest the "+" is invisible AND pointer-inert, so a click on the count
    // can't silently spawn; hover/keyboard focus bring it in.
    expect(plus.className).toMatch(/\bopacity-0\b/);
    expect(plus.className).toMatch(/\bpointer-events-none\b/);
    expect(plus.className).toMatch(/group-hover:pointer-events-auto/);
    expect(plus.className).toMatch(/focus-visible:opacity-100/);
    // The count yields its slot on hover.
    const count = slot?.querySelector("span");
    expect(count?.className).toMatch(/group-hover:opacity-0/);
    // Still spawns in the project's own provider (bug #2).
    fireEvent.click(plus);
    expect(useStore.getState().createSession).toHaveBeenCalledWith(
      "/repo/autonomOS",
      { provider: PROJECT.sessions[0].provider },
    );
  });

  it("disclosure uses the ORIGINAL ▶/▼ glyph, not a rotating chevron (Terry's live-gate revert)", () => {
    renderItem();
    const header = screen.getByRole("button", { expanded: true });
    // Seeded expanded → ▼, and no SVG chevron anywhere in the toggle.
    expect(header.textContent?.startsWith("▼")).toBe(true);
    expect(header.querySelector("svg")).toBeNull();
    act(() => useStore.setState({ expandedProjects: {} }));
    const collapsed = screen.getByRole("button", { expanded: false });
    expect(collapsed.textContent?.startsWith("▶")).toBe(true);
  });
});

describe("ProjectItem — status frames (render fan-out)", () => {
  /** Render inside a Profiler and return a live commit counter. */
  function renderCounted() {
    let commits = 0;
    render(
      <Profiler
        id="project-item"
        onRender={() => {
          commits += 1;
        }}
      >
        <ProjectItem
          project={PROJECT}
          page={page}
          liveSessionIds={new Set(["cc-live"])}
          onAgentContextMenu={vi.fn()}
        />
      </Profiler>,
    );
    return () => commits;
  }

  it("a COLLAPSED project does not re-render when an agent's status changes", () => {
    useStore.setState({ expandedProjects: {} });
    const commits = renderCounted();
    const before = commits();
    act(() => {
      useStore.setState({ agentStatuses: { "live-1": { status: "idle" } } });
    });
    expect(commits()).toBe(before);
  });

  it("an EXPANDED project re-renders and shows the new status", () => {
    const commits = renderCounted();
    const live = screen.getByText("live session").closest("button");
    if (!live) throw new Error("no row");
    // Seeded "working" → the aria-labelled Working badge.
    expect(within(live).queryByLabelText("Working")).toBeTruthy();
    const before = commits();
    act(() => {
      useStore.setState({ agentStatuses: { "live-1": { status: "idle" } } });
    });
    expect(commits()).toBeGreaterThan(before);
    // The rendered dot follows the new status (the badge is gone).
    expect(within(live).queryByLabelText("Working")).toBeNull();
  });

  it("a status change while COLLAPSED shows up as soon as the project is expanded", () => {
    useStore.setState({ expandedProjects: {} });
    renderCounted();
    act(() => {
      useStore.setState({ agentStatuses: { "live-1": { status: "idle" } } });
      useStore.setState({ agentStatuses: { "live-1": { status: "working" } } });
    });
    act(() => {
      useStore.setState({ expandedProjects: { "/repo/autonomOS": true } });
    });
    const live = screen.getByText("live session").closest("button");
    if (!live) throw new Error("no row");
    // The CURRENT status (working → the Working badge), not a stale one.
    expect(within(live).getByLabelText("Working")).toBeTruthy();
  });
});
