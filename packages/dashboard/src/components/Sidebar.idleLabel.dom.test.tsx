// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { type SessionInfo, useStore } from "../store";
import { Sidebar } from "./Sidebar";

/**
 * Terry's two picks wired into real SessionRows:
 *  (a) "ready" and "idle" both render ONE label, "Idle", on every provider
 *      (Codex never emits ready; Claude/Gemini emit it on start/resume/clear).
 *  T1  a passive Idle label fades on the SAME ramp as its row's timestamp,
 *      while needs-input / error / the working shimmer stay full strength.
 * The pure mapping lives in recency.test.ts; this pins the integration.
 */

const NOW = Date.now();
const DAY = 86_400_000;
function sess(id: string, provider: string, ageDays: number): SessionInfo {
  return {
    id,
    name: id,
    status: "running",
    workingDirectory: "/tmp",
    provider,
    claudeSessionId: id,
    createdAt: NOW - ageDays * DAY,
    updatedAt: NOW - ageDays * DAY,
  } as SessionInfo;
}

// Distinct ancient ages → distinct timestamp text per row ("30d", "31d", …).
const AGENTS = [
  sess("cc-ready", "claude-code", 30),
  sess("cc-idle", "claude-code", 31),
  sess("codex-idle", "codex", 32),
  sess("gem-ready", "gemini-cli", 33),
  sess("gem-idle", "gemini-cli", 34),
  sess("blocked", "claude-code", 35),
  sess("broken", "codex", 36),
  sess("busy", "gemini-cli", 37),
];
const STATUS: Record<string, string> = {
  "cc-ready": "ready",
  "cc-idle": "idle",
  "codex-idle": "idle",
  "gem-ready": "ready",
  "gem-idle": "idle",
  blocked: "needs_input",
  broken: "error",
  busy: "working",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = typeof url === "string" ? url : "";
      let body: unknown = {};
      // The status poll must echo the seeded statuses (real endpoint shape),
      // or its first response clears them before the rows render a label.
      if (u.includes("/api/agent-status"))
        body = Object.fromEntries(
          Object.entries(STATUS).map(([id, status]) => [
            id,
            { status: { status }, unread: 0 },
          ]),
        );
      else if (u.includes("/api/agents") && !u.includes("/tree")) body = AGENTS;
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
    sessions: AGENTS,
    exitedSessions: [],
    agentStatuses: Object.fromEntries(
      Object.entries(STATUS).map(([id, status]) => [id, { status }]),
    ),
    pinnedOrder: [],
    unpinnedOrder: AGENTS.map((a) => a.id),
    theme: "void",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The status label span on the row whose name is `name`. */
async function labelOf(name: string): Promise<HTMLElement> {
  const nameEl = await screen.findByText(name);
  const body = nameEl.parentElement?.parentElement;
  const label = body?.children[1]?.lastElementChild as HTMLElement | undefined;
  if (!label) throw new Error(`no label for ${name}`);
  return label;
}

describe("Sidebar — one Idle label (pick a)", () => {
  it("renders ready AND idle as 'Idle' on Claude Code, Codex, and Gemini", async () => {
    render(<Sidebar />);
    for (const id of [
      "cc-ready",
      "cc-idle",
      "codex-idle",
      "gem-ready",
      "gem-idle",
    ]) {
      expect((await labelOf(id)).textContent).toBe("Idle");
    }
    expect(screen.queryByText("Ready")).toBeNull();
  });
});

describe("Sidebar — passive label recency fade (pick T1)", () => {
  it("an ancient Idle label fades to the same opacity as its timestamp (void → 0.52)", async () => {
    render(<Sidebar />);
    for (const [id, age] of [
      ["cc-ready", "30d"],
      ["codex-idle", "32d"],
      ["gem-idle", "34d"],
    ]) {
      expect(await labelOf(id)).toHaveStyle({ opacity: "0.52" });
      expect(screen.getByText(age)).toHaveStyle({ opacity: "0.52" });
    }
  });

  it("uses the light ramp on daylight (ancient → 0.74), matching the timestamp", async () => {
    useStore.setState({ theme: "daylight" });
    render(<Sidebar />);
    expect(await labelOf("cc-idle")).toHaveStyle({ opacity: "0.74" });
    expect(screen.getByText("31d")).toHaveStyle({ opacity: "0.74" });
  });

  it("NEVER fades needs-input, error, or the working shimmer, however stale", async () => {
    render(<Sidebar />);
    const blocked = await labelOf("blocked");
    const broken = await labelOf("broken");
    const busy = await labelOf("busy");
    expect(blocked.textContent).toBe("Needs input");
    expect(blocked).toHaveStyle({ opacity: "1" });
    expect(broken.textContent).toBe("Error");
    expect(broken).toHaveStyle({ opacity: "1" });
    expect(busy).toHaveClass("status-shimmer");
    expect(busy.style.opacity).toBe("");
    // their timestamps still fade — only the label is exempt
    expect(screen.getByText("35d")).toHaveStyle({ opacity: "0.52" });
  });
});
