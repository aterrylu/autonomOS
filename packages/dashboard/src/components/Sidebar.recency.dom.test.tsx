// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * Recency B2 — timestamp-only fade, WIRED into a real SessionRow.
 *
 * The pure mapping is covered in recency.test.ts; this pins the integration:
 * that the row actually applies recencyTimestampStyle to the last-activity
 * span, that the age flows from the session (createdAt, since no meta is
 * stubbed → lastActive falls back to s.createdAt), and that the theme's
 * recencyFresh token reaches the fresh tint. Breaking any of those turns this
 * red — a plain-opacity regression, a dropped theme token, or a mis-wired span.
 */

const NOW = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;

function sess(id: string, ageMs: number): SessionInfo {
  return {
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude",
    claudeSessionId: id,
    createdAt: NOW - ageMs,
    updatedAt: NOW - ageMs,
  };
}

// A fresh (<1h) and an ancient (>7d) agent. The mount fetch must echo them back
// or fetchSessions prunes the seeded order; carrying createdAt in the payload
// keeps the controlled ages whether the row reads the seed or the fetch result.
const FRESH = sess("fresh-agent", 10 * MIN); // → "10m", fresh, opacity 1 + tint
const ANCIENT = sess("ancient-agent", 30 * DAY); // → "30d", ancient, opacity 0.35

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      let body: unknown = {};
      if (u.includes("/api/agents") && !u.includes("/tree")) {
        body = [FRESH, ANCIENT];
      } else if (u.includes("/api/agents") || u.includes("/api/projects")) {
        body = [];
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }),
  );
}

beforeEach(() => {
  stubFetch();
  useStore.setState({
    sidebarViewMode: "flat",
    sidebarViewModeExplicit: true,
    sessions: [FRESH, ANCIENT],
    exitedSessions: [],
    agentStatuses: {},
    pinnedOrder: [],
    unpinnedOrder: ["fresh-agent", "ancient-agent"],
    theme: "void",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Sidebar recency — timestamp fade wiring", () => {
  it("fades an ancient (>7d) row's timestamp to 52% opacity", async () => {
    render(<Sidebar />);
    const age = await screen.findByText("30d");
    expect(age).toHaveStyle({ opacity: "0.52" });
  });

  it("keeps a fresh (<1h) row's timestamp at full opacity in the theme foreground", async () => {
    render(<Sidebar />);
    const age = await screen.findByText("10m");
    expect(age).toHaveStyle({ opacity: "1" });
    // void's foreground #d4d4d4 → rgb(212, 212, 212); proves the theme's fg
    // flows all the way to the span, not a hardcoded gray.
    expect(age).toHaveStyle({ color: "rgb(212, 212, 212)" });
  });

  it("leaves the fresh row's NAME untouched (B2 is timestamp-only)", async () => {
    render(<Sidebar />);
    // The name for the ancient agent must NOT inherit the fade — only the
    // timestamp span carries opacity. The name span sits in the same row.
    const name = await screen.findByText("ancient-agent");
    expect(name).not.toHaveStyle({ opacity: "0.52" });
  });

  it("does NOT fade a row with a missing timestamp — 'unknown' stays full opacity", async () => {
    // A createdAt of 0 (pre-schema / missing) renders "unknown" via formatAge.
    // The fade must guard the timestamp, not the derived age: `now - 0` is a
    // huge positive age that would wrongly bucket ancient (0.52). Regression
    // guard for the "unknown faded to near-invisibility" bug.
    const broken: SessionInfo = { ...sess("broken-agent", 0), createdAt: 0 };
    useStore.setState({
      sessions: [broken],
      unpinnedOrder: ["broken-agent"],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const u = typeof url === "string" ? url : "";
        let body: unknown = {};
        if (u.includes("/api/agents") && !u.includes("/tree")) body = [broken];
        else if (u.includes("/api/agents") || u.includes("/api/projects"))
          body = [];
        return Promise.resolve(
          new Response(JSON.stringify(body), { status: 200 }),
        );
      }),
    );
    render(<Sidebar />);
    const age = await screen.findByText("unknown");
    expect(age).toHaveStyle({ opacity: "1" });
  });
});
