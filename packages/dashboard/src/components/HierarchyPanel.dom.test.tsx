// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test/setup-dom";
import { useStore } from "../store";
import { HierarchyPanel } from "./HierarchyPanel";

/**
 * HierarchyPanel — the org-chart view. It fetches /api/agents/tree on mount and
 * renders one of: loading / error / empty / a tree of AgentCards. We stub the
 * fetch to drive each content state and assert the right message / cards. The
 * status overlay/activity is sourced from the Zustand store, which we seed.
 */

/** Real `Response` objects, not `{ ok, json }` duck types: the api client reads
 *  the body via `res.text()`, so a partial stub would fail the parse rather
 *  than the assertion under test. */
function stubTreeFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (typeof url === "string" && url.includes("/api/agents/tree")) {
        return impl();
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    }),
  );
}

beforeEach(() => {
  // Quiet store baseline — no live/exited sessions, no statuses.
  useStore.setState({
    sessions: [],
    exitedSessions: [],
    agentStatuses: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HierarchyPanel", () => {
  it("shows the empty-state guidance when no agents are running", async () => {
    stubTreeFetch(() => Promise.resolve(new Response("[]", { status: 200 })));
    render(<HierarchyPanel />);
    expect(await screen.findByText(/no agents running/i)).toBeInTheDocument();
    expect(screen.getByText(/set_manager\(\)/i)).toBeInTheDocument();
  });

  it("shows an error state with retry copy when the server returns non-ok", async () => {
    stubTreeFetch(() => Promise.resolve(new Response(null, { status: 500 })));
    render(<HierarchyPanel />);
    expect(
      await screen.findByText(/server error \(500\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/retrying automatically/i)).toBeInTheDocument();
  });

  it("shows 'Cannot reach server' when the fetch rejects", async () => {
    stubTreeFetch(() => Promise.reject(new Error("network down")));
    render(<HierarchyPanel />);
    expect(await screen.findByText(/cannot reach server/i)).toBeInTheDocument();
  });

  it("renders an agent card with name, template and status for a returned tree", async () => {
    stubTreeFetch(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              claudeSessionId: "sess-1",
              name: "Dispatcher",
              template: "dispatcher",
              status: "running",
              children: [],
            },
          ]),
          { status: 200 },
        ),
      ),
    );

    // Seed the activity status looked up by claudeSessionId.
    useStore.setState({
      sessions: [
        {
          id: "store-1",
          claudeSessionId: "sess-1",
          name: "Dispatcher",
          status: "running",
        } as never,
      ],
      agentStatuses: { "store-1": { status: "working" } },
    });

    render(<HierarchyPanel />);
    expect(await screen.findByText("Dispatcher")).toBeInTheDocument();
    expect(screen.getByText("dispatcher")).toBeInTheDocument(); // template pill
    // "working" → label "Working"
    expect(screen.getByText("Working")).toBeInTheDocument();
  });
});
