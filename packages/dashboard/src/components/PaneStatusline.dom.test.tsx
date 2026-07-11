// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import "../test/setup-dom";
import { type SessionInfo, useStore } from "../store";
import { PaneStatusline } from "./PaneStatusline";

/**
 * PaneStatusline — the dashboard-chrome statusline under a terminal pane.
 *
 * The interesting logic is the gating (which providers/settings show the bar)
 * and the derived identity (name@project · ↑manager · ↓N reports · standalone),
 * so those are what we assert. Data is seeded straight into the Zustand store,
 * mirroring the real /api/agents → SessionInfo + /api/hooks → agentStatuses flow.
 */

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "a1",
    name: "Worker",
    status: "running",
    workingDirectory: "/home/me/autonomOS",
    provider: "codex",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

function seed(opts: {
  sessions: SessionInfo[];
  statuses?: Record<string, { status: string; currentTool?: string }>;
  statusLineEnabled?: boolean;
}) {
  useStore.setState({
    sessions: opts.sessions,
    agentStatuses: opts.statuses ?? {},
    statusLineEnabled: opts.statusLineEnabled ?? true,
  });
}

beforeEach(() => {
  seed({ sessions: [] });
});

describe("PaneStatusline — gating", () => {
  it("renders for a Codex agent", () => {
    seed({ sessions: [session({ id: "a1", provider: "codex" })] });
    const { container } = render(<PaneStatusline sessionId="a1" />);
    expect(container.querySelector('svg[aria-label="Codex"]')).not.toBeNull();
  });

  it("renders for a Gemini agent", () => {
    seed({ sessions: [session({ id: "a1", provider: "gemini-cli" })] });
    const { container } = render(<PaneStatusline sessionId="a1" />);
    expect(container.querySelector('svg[aria-label="Gemini"]')).not.toBeNull();
  });

  it("hides for a Claude agent when the in-terminal statusline is ON", () => {
    seed({
      sessions: [session({ id: "a1", provider: "claude-code" })],
      statusLineEnabled: true,
    });
    const { container } = render(<PaneStatusline sessionId="a1" />);
    // Gated off entirely — no bar, so it can't double up with the terminal one.
    expect(container.firstChild).toBeNull();
  });

  it("shows for a Claude agent when the in-terminal statusline is OFF", () => {
    seed({
      sessions: [session({ id: "a1", provider: "claude-code" })],
      statusLineEnabled: false,
    });
    const { container } = render(<PaneStatusline sessionId="a1" />);
    expect(container.querySelector('svg[aria-label="Claude"]')).not.toBeNull();
  });

  it("renders nothing when the session is exited", () => {
    seed({ sessions: [session({ id: "a1", status: "exited" })] });
    const { container } = render(<PaneStatusline sessionId="a1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the session id is unknown", () => {
    seed({ sessions: [session({ id: "a1" })] });
    const { container } = render(<PaneStatusline sessionId="missing" />);
    expect(container.firstChild).toBeNull();
  });
});

describe("PaneStatusline — identity", () => {
  it("shows name and appends the project from the working directory", () => {
    seed({
      sessions: [
        session({ id: "a1", name: "Worker", workingDirectory: "/x/autonomOS" }),
      ],
    });
    render(<PaneStatusline sessionId="a1" />);
    expect(screen.getByText("Worker")).toBeInTheDocument();
    expect(screen.getByText("@autonomOS")).toBeInTheDocument();
  });

  it("prefers an explicit project over the cwd basename", () => {
    seed({
      sessions: [
        session({ id: "a1", project: "homelab", workingDirectory: "/x/repo" }),
      ],
    });
    render(<PaneStatusline sessionId="a1" />);
    expect(screen.getByText("@homelab")).toBeInTheDocument();
  });

  it("shows the manager and a pluralized report count", () => {
    seed({
      sessions: [
        session({ id: "a1", name: "Lead", manager: "Boss" }),
        session({ id: "a2", name: "R1", manager: "Lead" }),
        session({ id: "a3", name: "R2", manager: "Lead" }),
      ],
    });
    render(<PaneStatusline sessionId="a1" />);
    expect(screen.getByText("↑Boss")).toBeInTheDocument();
    expect(screen.getByText("↓2 reports")).toBeInTheDocument();
  });

  it("singularizes a single report", () => {
    seed({
      sessions: [
        session({ id: "a1", name: "Lead" }),
        session({ id: "a2", name: "R1", manager: "Lead" }),
      ],
    });
    render(<PaneStatusline sessionId="a1" />);
    expect(screen.getByText("↓1 report")).toBeInTheDocument();
  });

  it("shows 'standalone' with no manager and no reports", () => {
    seed({ sessions: [session({ id: "a1", name: "Solo" })] });
    render(<PaneStatusline sessionId="a1" />);
    expect(screen.getByText("standalone")).toBeInTheDocument();
  });
});

describe("PaneStatusline — activity", () => {
  it("shows the git branch when present", () => {
    seed({ sessions: [session({ id: "a1", branch: "terry/feature" })] });
    render(<PaneStatusline sessionId="a1" />);
    expect(screen.getByText(/terry\/feature/)).toBeInTheDocument();
  });

  it("reflects the live status label", () => {
    seed({
      sessions: [session({ id: "a1" })],
      statuses: { a1: { status: "working" } },
    });
    render(<PaneStatusline sessionId="a1" />);
    expect(screen.getByText("Working")).toBeInTheDocument();
  });
});
