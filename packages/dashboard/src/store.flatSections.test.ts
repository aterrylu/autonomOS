import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFlatSections, type SessionInfo, useStore } from "./store";

// ── Helpers ──────────────────────────────────────────────────────────

/** Minimal SessionInfo with claudeSessionId === id, so the order key == id. */
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

/** Section sessions → their order keys, for terse assertions. */
function keys(sessions: SessionInfo[]): string[] {
  return sessions.map((s) => s.id);
}

// ── buildFlatSections (pure) ─────────────────────────────────────────

describe("buildFlatSections", () => {
  it("returns empty sections for no items", () => {
    const r = buildFlatSections([], [], []);
    expect(r.pinned).toEqual([]);
    expect(r.unpinned).toEqual([]);
  });

  it("orders unpinned by unpinnedOrder", () => {
    const r = buildFlatSections(
      [sess("a"), sess("b"), sess("c")],
      [],
      ["c", "a", "b"],
    );
    expect(keys(r.pinned)).toEqual([]);
    expect(keys(r.unpinned)).toEqual(["c", "a", "b"]);
  });

  it("places pinned (in pinnedOrder) above unpinned", () => {
    const r = buildFlatSections(
      [sess("a"), sess("b"), sess("c")],
      ["b"],
      ["a", "c"],
    );
    expect(keys(r.pinned)).toEqual(["b"]);
    expect(keys(r.unpinned)).toEqual(["a", "c"]);
  });

  it("prepends a fresh arrival (in neither array) to the top of unpinned", () => {
    const r = buildFlatSections(
      [sess("a"), sess("b"), sess("fresh")],
      [],
      ["a", "b"],
    );
    expect(keys(r.unpinned)).toEqual(["fresh", "a", "b"]);
  });

  it("a fresh arrival never lands in the pinned section", () => {
    const r = buildFlatSections([sess("a"), sess("fresh")], ["a"], []);
    expect(keys(r.pinned)).toEqual(["a"]);
    expect(keys(r.unpinned)).toEqual(["fresh"]);
  });

  it("ignores stale keys with no matching live item", () => {
    const r = buildFlatSections(
      [sess("a")],
      ["dead-pinned"],
      ["a", "dead-unpinned"],
    );
    expect(keys(r.pinned)).toEqual([]);
    expect(keys(r.unpinned)).toEqual(["a"]);
  });

  it("dedupes a key present in both arrays — pinned wins", () => {
    const r = buildFlatSections([sess("a")], ["a"], ["a"]);
    expect(keys(r.pinned)).toEqual(["a"]);
    expect(keys(r.unpinned)).toEqual([]);
  });

  it("places a new arrival in unpinned even when every existing agent is pinned", () => {
    // All of a,b,c pinned (unpinnedOrder empty); a fresh 'd' spawns.
    const r = buildFlatSections(
      [sess("a"), sess("b"), sess("c"), sess("d")],
      ["a", "b", "c"],
      [],
    );
    expect(keys(r.pinned)).toEqual(["a", "b", "c"]);
    expect(keys(r.unpinned)).toEqual(["d"]); // not missing, not pinned
  });
});

// ── Reducers: pinAgent / unpinAgent / reorderFlat ────────────────────

function seed(opts: {
  sessions: string[];
  pinnedOrder?: string[];
  unpinnedOrder?: string[];
}) {
  useStore.setState({
    sessions: opts.sessions.map(sess),
    pinnedOrder: opts.pinnedOrder ?? [],
    unpinnedOrder: opts.unpinnedOrder ?? [],
  });
}

const get = () => useStore.getState();

describe("pinAgent", () => {
  beforeEach(() => {
    seed({ sessions: ["a", "b", "c"], unpinnedOrder: ["a", "b", "c"] });
  });

  it("moves an agent to the BOTTOM of the pinned section", () => {
    get().pinAgent("b");
    expect(get().pinnedOrder).toEqual(["b"]);
    expect(get().unpinnedOrder).toEqual(["a", "c"]);
  });

  it("appends successive pins (preserves existing pin order)", () => {
    get().pinAgent("b");
    get().pinAgent("a");
    expect(get().pinnedOrder).toEqual(["b", "a"]); // a appended, not prepended
    expect(get().unpinnedOrder).toEqual(["c"]);
  });

  it("is a no-op when already pinned", () => {
    get().pinAgent("b");
    const before = get().pinnedOrder;
    get().pinAgent("b");
    expect(get().pinnedOrder).toEqual(before);
  });

  it("freezes a fresh arrival's position when pinning a different agent", () => {
    // 'fresh' is live but in neither array → displayed at top of unpinned.
    seed({
      sessions: ["a", "b", "fresh"],
      unpinnedOrder: ["a", "b"],
    });
    get().pinAgent("a");
    expect(get().pinnedOrder).toEqual(["a"]);
    // 'fresh' is frozen at the top of unpinned, not dropped.
    expect(get().unpinnedOrder).toEqual(["fresh", "b"]);
  });
});

describe("unpinAgent", () => {
  beforeEach(() => {
    seed({
      sessions: ["a", "b", "c"],
      pinnedOrder: ["b", "a"],
      unpinnedOrder: ["c"],
    });
  });

  it("moves an agent to the TOP of the unpinned section", () => {
    get().unpinAgent("b");
    expect(get().pinnedOrder).toEqual(["a"]);
    expect(get().unpinnedOrder).toEqual(["b", "c"]); // prepended
  });

  it("is a no-op when not pinned", () => {
    get().unpinAgent("c");
    expect(get().pinnedOrder).toEqual(["b", "a"]);
    expect(get().unpinnedOrder).toEqual(["c"]);
  });

  it("round-trips with pinAgent (pin → bottom, unpin → top)", () => {
    seed({ sessions: ["a", "b", "c"], unpinnedOrder: ["a", "b", "c"] });
    get().pinAgent("a");
    get().unpinAgent("a");
    expect(get().pinnedOrder).toEqual([]);
    expect(get().unpinnedOrder).toEqual(["a", "b", "c"]); // a back on top
  });
});

describe("reorderFlat", () => {
  it("reorders within the unpinned section, leaving pinned untouched", () => {
    seed({
      sessions: ["a", "b", "c", "p"],
      pinnedOrder: ["p"],
      unpinnedOrder: ["a", "b", "c"],
    });
    get().reorderFlat("unpinned", 0, 2); // move 'a' to the end
    expect(get().unpinnedOrder).toEqual(["b", "c", "a"]);
    expect(get().pinnedOrder).toEqual(["p"]);
  });

  it("reorders within the pinned section, leaving unpinned untouched", () => {
    seed({
      sessions: ["a", "b", "c"],
      pinnedOrder: ["a", "b"],
      unpinnedOrder: ["c"],
    });
    get().reorderFlat("pinned", 1, 0); // move 'b' to the front
    expect(get().pinnedOrder).toEqual(["b", "a"]);
    expect(get().unpinnedOrder).toEqual(["c"]);
  });

  it("prunes a dead key while freezing on a no-op reorder", () => {
    // 'c' was killed but lingers in unpinnedOrder.
    seed({
      sessions: ["a", "b"],
      unpinnedOrder: ["a", "b", "c"],
    });
    get().reorderFlat("unpinned", 0, 0); // no move, but re-freezes/prunes
    expect(get().unpinnedOrder).toEqual(["a", "b"]);
  });
});

describe("remapSessionIds (restart id remap)", () => {
  it("remaps pinned and unpinned session keys via the id map", () => {
    seed({
      sessions: ["old-pinned", "old-unpinned"],
      pinnedOrder: ["old-pinned"],
      unpinnedOrder: ["old-unpinned"],
    });
    get().remapSessionIds({
      "old-pinned": "new-pinned",
      "old-unpinned": "new-unpinned",
    });
    expect(get().pinnedOrder).toEqual(["new-pinned"]);
    expect(get().unpinnedOrder).toEqual(["new-unpinned"]);
  });

  it("leaves unmapped keys untouched", () => {
    seed({
      sessions: ["a"],
      pinnedOrder: ["a"],
      unpinnedOrder: ["unmapped", "also-unmapped"],
    });
    get().remapSessionIds({ a: "a2" });
    expect(get().pinnedOrder).toEqual(["a2"]);
    expect(get().unpinnedOrder).toEqual(["unmapped", "also-unmapped"]);
  });
});

describe("fetchSessions prune (pinned agent exits)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops a pinned agent from pinnedOrder once it is no longer live", async () => {
    // 'dead' is pinned but the next /api/agents response omits it.
    useStore.setState({
      activePane: null,
      sessions: [sess("alive"), sess("dead")],
      exitedSessions: [],
      pinnedOrder: ["dead"],
      unpinnedOrder: ["alive"],
    });
    // A real `Response` — the api client reads the body via `res.text()`, so an
    // `{ ok, json }` duck type would fail the parse instead of the assertion.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              typeof url === "string" && url.includes("/api/agents")
                ? [
                    {
                      id: "alive",
                      name: "alive",
                      status: "running",
                      workingDirectory: "/tmp",
                      provider: "claude",
                      createdAt: 1,
                      updatedAt: 1,
                    },
                  ]
                : {},
            ),
            { status: 200 },
          ),
        ),
      ),
    );

    await get().fetchSessions();

    expect(get().pinnedOrder).toEqual([]); // 'dead' pruned
    expect(get().unpinnedOrder).toEqual(["alive"]);
  });
});
