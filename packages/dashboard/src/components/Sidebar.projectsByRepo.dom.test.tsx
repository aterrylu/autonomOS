// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { Sidebar } from "./Sidebar";

// The repo-grouped shape #438 returns: a repo whose sessions ran in the repo
// AND in worktrees (one deleted), automated review runs, and a temp dir.
const REPO = "/Users/t/workspace/autonomOS";
const WT = "/Users/t/.claude-worktrees/autonomOS-terry-x";
const GONE = "/Users/t/.claude-worktrees/autonomOS-terry-merged";
const sess = (id: string, extra: Record<string, unknown> = {}) => ({
  sessionId: id,
  summary: id,
  lastModified: 0,
  provider: "claude-code",
  cwd: REPO,
  cwdExists: true,
  headless: false,
  ...extra,
});
const PROJECTS = [
  {
    path: REPO,
    name: "autonomOS",
    kind: "repo",
    lastActive: 9,
    counts: { visible: 3, headless: 2, removed: 1 },
    sessions: [
      sess("TeamLead", { lastModified: 9, gitBranch: "main" }),
      sess("worktree-agent", {
        lastModified: 8,
        cwd: WT,
        gitBranch: "terry/x",
      }),
      sess("codex-in-wt", { lastModified: 7, cwd: WT, provider: "codex" }),
      sess("merged-branch-agent", {
        lastModified: 6,
        cwd: GONE,
        cwdExists: false,
      }),
      sess("review-bot-1", { lastModified: 5, cwd: WT, headless: true }),
      sess("review-bot-2", {
        lastModified: 4,
        cwd: GONE,
        cwdExists: false,
        headless: true,
      }),
    ],
  },
  {
    path: "/private/tmp/aos-live.x",
    name: "aos-live.x",
    kind: "temp",
    lastActive: 1,
    counts: { visible: 1, headless: 0, removed: 0 },
    sessions: [sess("qa-probe", { cwd: "/private/tmp/aos-live.x" })],
  },
];

let resume: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      const body = u.includes("/api/projects") ? PROJECTS : [];
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }),
  );
  resume = vi.fn(() => Promise.resolve());
  useStore.setState({
    sidebarViewMode: "flat",
    sidebarViewModeExplicit: true,
    sessions: [],
    exitedSessions: [],
    projects: PROJECTS as never,
    expandedProjects: {},
    showAutomatedRuns: false,
    otherProjectsOpen: false,
    resumeSession: resume as never,
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  useStore.setState({
    projects: [],
    showAutomatedRuns: false,
    otherProjectsOpen: false,
  });
});

const openRepo = () => fireEvent.click(screen.getByText("autonomOS"));

describe("Projects grouped by git repo", () => {
  it("one repo row; its count is interactive sessions in existing dirs (3), not all 6", () => {
    render(<Sidebar />);
    const header = screen
      .getByText("autonomOS")
      .closest("div.group") as HTMLElement;
    expect(within(header).getByText("3")).toBeTruthy();
  });

  it("automated runs are hidden until asked, then shown IN the repo and tagged", () => {
    render(<Sidebar />);
    openRepo();
    expect(screen.queryByText("review-bot-1")).toBeNull();
    fireEvent.click(screen.getByText("Show 2 automated runs"));
    expect(screen.getByText("review-bot-1")).toBeTruthy();
    expect(screen.getAllByText("automated").length).toBeGreaterThan(0);
    expect(screen.getByText("Hide automated runs")).toBeTruthy();
  });

  it("sessions from removed directories wait behind the repo's own toggle", () => {
    render(<Sidebar />);
    openRepo();
    expect(screen.queryByText("merged-branch-agent")).toBeNull();
    fireEvent.click(screen.getByText("Show 1 from removed directories"));
    expect(screen.getByText("merged-branch-agent")).toBeTruthy();
  });

  it("temp dirs sit in ONE collapsed 'Other' group", () => {
    render(<Sidebar />);
    expect(screen.queryByText("aos-live.x")).toBeNull();
    fireEvent.click(screen.getByText(/Other · test & temp dirs/));
    expect(screen.getByText("aos-live.x")).toBeTruthy();
  });

  it("resuming a worktree session uses the WORKTREE path, not the repo root", () => {
    render(<Sidebar />);
    openRepo();
    fireEvent.click(screen.getByText("worktree-agent"));
    expect(resume).toHaveBeenCalledWith(
      "worktree-agent",
      WT,
      "worktree-agent",
      expect.anything(),
    );
  });

  it("branch chip: CC's git branch; a branchless Codex row names its worktree", () => {
    render(<Sidebar />);
    openRepo();
    const row = (id: string) =>
      screen.getByText(id).closest("button") as HTMLElement;
    expect(within(row("worktree-agent")).getByText("terry/x")).toBeTruthy();
    expect(within(row("codex-in-wt")).getByText("terry-x")).toBeTruthy();
  });
});
