// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import type { ProjectInfo } from "../store";
import { THEMES, useStore } from "../store";
import { ProjectItem } from "./Sidebar";

/**
 * The redesigned Projects row's three states + decision-C behavior:
 *   live (ours + running)  → a "Live ↗" chip; click JUMPS to the live pane.
 *   stopped (ours + exited)→ a "Stopped" indicator; click resumes.
 *   external (unmanaged)   → a "Resume" affordance; click resumes/adopts.
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
  it("a LIVE row shows a Live chip and JUMPS to the pane (not resume)", () => {
    renderItem();
    const row = screen.getByText("live session").closest("button");
    if (!row) throw new Error("no row");
    expect(within(row).getByText("Live")).toBeTruthy();
    fireEvent.click(row);
    expect(useStore.getState().switchPane).toHaveBeenCalledWith({
      type: "session",
      id: "live-1",
    });
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

  it("collapsing routes through the store, not per-mount state (bug #8)", () => {
    renderItem();
    fireEvent.click(screen.getByText("autonomOS"));
    expect(useStore.getState().toggleProjectExpanded).toHaveBeenCalledWith(
      "/repo/autonomOS",
    );
  });
});
