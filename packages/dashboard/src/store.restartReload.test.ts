import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "./api/agents";
import {
  applyAgentsSnapshot,
  RESTART_PANE_GUARD_MS,
  restartingIds,
  useStore,
} from "./store";

// restartSession composes kill → attach → fetchSessions → switchPane, and now
// also bumps the per-session terminal-reload nonce so the pane deterministically
// re-acquires a fresh terminal bound to the new PTY (fixing the terminal-gone
// bug when restarting the already-focused agent). We mock the API and stub the
// downstream store methods so this exercises restartSession's own wiring.
vi.mock("./api/agents", () => ({
  agentsApi: {
    kill: vi.fn().mockResolvedValue({ ok: true, id: "a1" }),
    attach: vi.fn().mockResolvedValue({ id: "a1" }),
  },
}));

beforeEach(() => {
  useStore.setState({
    terminalReloadNonce: {},
    fetchSessions: vi.fn().mockResolvedValue(undefined),
    switchPane: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
  } as any);
});
afterEach(() => {
  restartingIds.clear();
  vi.clearAllMocks();
});

describe("reloadTerminal", () => {
  it("bumps the per-session nonce (0 → 1 → 2), isolated per id", () => {
    useStore.getState().reloadTerminal("a1");
    expect(useStore.getState().terminalReloadNonce.a1).toBe(1);
    useStore.getState().reloadTerminal("a1");
    expect(useStore.getState().terminalReloadNonce.a1).toBe(2);
    // A different session is untouched.
    expect(useStore.getState().terminalReloadNonce.b2 ?? 0).toBe(0);
  });
});

describe("restartSession — terminal reconnect", () => {
  it("bumps the reload nonce after a successful attach (so the pane reconnects)", async () => {
    await useStore.getState().restartSession("a1");
    expect(agentsApi.attach).toHaveBeenCalledWith("a1");
    expect(useStore.getState().terminalReloadNonce.a1).toBe(1);
    // And it re-opened the pane (the #353 refocus).
    expect(useStore.getState().switchPane).toHaveBeenCalledWith({
      type: "session",
      id: "a1",
    });
  });

  it("does NOT bump the nonce when attach FAILS (no new PTY to reconnect to)", async () => {
    (agentsApi.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("attach failed"),
    );
    await useStore.getState().restartSession("a1");
    expect(useStore.getState().terminalReloadNonce.a1 ?? 0).toBe(0);
    // Nor does it re-open a pane onto a stopped agent.
    expect(useStore.getState().switchPane).not.toHaveBeenCalled();
  });
});

// The pane must survive the kill→attach gap. A restart transiently marks the
// record `exited`, and BOTH snapshot-driven teardown paths key off "not live":
// applyAgentsSnapshot's fallback (tested here) and DockviewLayout's pruneDead
// (verified in the real browser). restartingIds gates both so a poll response
// captured mid-restart — landing LATE, after restartSession re-opened the pane —
// can't retarget it away. This was the actual hole behind Terry's "restarting
// closes the pane" report; the earlier reloadNonce fix only covered the pane
// that stayed OPEN.
describe("restart pane guard (restartingIds)", () => {
  /** Seed a single running pane the snapshot will then omit ("it died"). */
  function seedRunningPane() {
    useStore.setState({
      activePane: { type: "session", id: "a1" },
      sessions: [{ id: "a1", name: "a1", status: "running" }],
      exitedSessions: [],
      dvWorkspaces: {},
      dvPaneWorkspace: {},
      pinnedOrder: [],
      unpinnedOrder: [],
      sessionsInitialFetchDone: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);
  }

  it("KEEPS the active pane when a snapshot omits a mid-restart id", () => {
    seedRunningPane();
    restartingIds.add("a1");
    // The transient-exited snapshot (a1 absent) must NOT retarget the pane.
    applyAgentsSnapshot([]);
    expect(useStore.getState().activePane).toEqual({
      type: "session",
      id: "a1",
    });
  });

  it("control: retargets a dead pane away when NOT mid-restart", () => {
    seedRunningPane();
    // a1 is genuinely gone (not restarting) → fall back (null: no live sibling).
    applyAgentsSnapshot([]);
    expect(useStore.getState().activePane).toBeNull();
  });

  // The FOURTH teardown path (nox): reconcileDeadWorkspaces dissolves a drag-
  // composed split's binding when a member leaves the live set. A live sibling b1
  // keeps the group's panels alive, but dropping a1 from the 2-member group would
  // dissolve the binding (≤1 survivor) — so the guard must skip a mid-restart a1
  // here too, or the split silently unbinds and the next click collapses it.
  const liveSibling = {
    schemaVersion: 1,
    id: "b1",
    name: "b1",
    managerId: null,
    workingDirectory: "/x",
    permissionMode: "ask",
    status: "running",
    provider: "claude-code",
    providerSessionId: "b1",
    startedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    lastActivityAt: 0,
  };
  /** a1 + b1 bound into a drag-composed split workspace ws1. */
  function seedSplit() {
    useStore.setState({
      activePane: { type: "session", id: "a1" },
      sessions: [{ id: "a1", name: "a1", status: "running" }],
      exitedSessions: [],
      dvWorkspaces: { ws1: { paneIds: ["a1", "b1"], serialized: {} } },
      dvPaneWorkspace: { a1: "ws1", b1: "ws1" },
      pinnedOrder: [],
      unpinnedOrder: [],
      sessionsInitialFetchDone: true,
      // biome-ignore lint/suspicious/noExplicitAny: partial store patch for test
    } as any);
  }

  it("KEEPS a mid-restart pane's split binding (b1 live, a1 omitted)", () => {
    seedSplit();
    restartingIds.add("a1");
    applyAgentsSnapshot([liveSibling] as never);
    const st = useStore.getState();
    expect(st.dvWorkspaces.ws1?.paneIds).toEqual(["a1", "b1"]);
    expect(st.dvPaneWorkspace.a1).toBe("ws1");
  });

  it("control: dissolves the split binding when the dropped member is NOT restarting", () => {
    seedSplit();
    applyAgentsSnapshot([liveSibling] as never);
    const st = useStore.getState();
    expect(st.dvWorkspaces.ws1).toBeUndefined();
    expect(st.dvPaneWorkspace.a1).toBeUndefined();
  });

  it("restartSession arms the guard for the flow, then drops it after the drain", async () => {
    vi.useFakeTimers();
    try {
      await useStore.getState().restartSession("a1");
      // Held immediately after the flow so a late in-flight poll is still gated.
      expect(restartingIds.has("a1")).toBe(true);
      await vi.advanceTimersByTimeAsync(RESTART_PANE_GUARD_MS);
      expect(restartingIds.has("a1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the guard early on attach failure (the pane SHOULD retarget)", async () => {
    (agentsApi.attach as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("attach failed"),
    );
    await useStore.getState().restartSession("a1");
    // Agent is genuinely stopped — don't pin a dead pane for the drain window.
    expect(restartingIds.has("a1")).toBe(false);
  });
});
