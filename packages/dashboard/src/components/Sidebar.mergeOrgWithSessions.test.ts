import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../store";
import { mergeOrgWithSessions } from "./mergeOrgWithSessions";

/**
 * Tests for mergeOrgWithSessions — the client-side logic that joins the org
 * chart tree from /api/agents/tree with the live sessions from /api/agents.
 *
 * These guard against the reliability bugs fixed in this change:
 *  - Match by claudeSessionId so rename drift doesn't sever org nodes from
 *    their sessions.
 *  - Don't prune the tree when sessions haven't loaded yet (startup race).
 */

function makeSession(overrides: Partial<SessionInfo>): SessionInfo {
  return {
    id: "id-default",
    name: "default",
    status: "running",
    workingDirectory: "/tmp",
    provider: "claude-code",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("mergeOrgWithSessions", () => {
  it("matches by claudeSessionId even when org and session names differ (rename drift)", () => {
    // Simulates the window right after /rename: org chart still carries the
    // old persisted name "worker", live sessions already show the fresh JSONL
    // title "BackendWorker". Name-match would fail; id-match keeps the link.
    const orgRoots = [
      {
        name: "worker",
        claudeSessionId: "claude-abc",
        children: [],
      },
    ];
    const sessions = [
      makeSession({
        id: "sess-1",
        name: "BackendWorker",
        claudeSessionId: "claude-abc",
      }),
    ];

    const merged = mergeOrgWithSessions(orgRoots, sessions, true, {});

    expect(merged).toHaveLength(1);
    expect(merged[0].session?.id).toBe("sess-1");
  });

  it("falls back to case-insensitive name match when claudeSessionId is missing", () => {
    // Legacy org data or back-compat path: no claudeSessionId on the org node.
    const orgRoots = [{ name: "Alpha", children: [] }];
    const sessions = [makeSession({ id: "sess-alpha", name: "alpha" })];

    const merged = mergeOrgWithSessions(orgRoots, sessions, true, {});

    expect(merged).toHaveLength(1);
    expect(merged[0].session?.id).toBe("sess-alpha");
  });

  it("does not prune the tree when sessions is empty (startup race)", () => {
    // On first mount, /api/agents/tree may resolve before /api/agents. If we pruned
    // eagerly here, every node would vanish because none can match an empty
    // sessions array — user sees "No active agents" until sessions arrive.
    const orgRoots = [
      { name: "CEO", claudeSessionId: "c-1", children: [] },
      { name: "Worker", claudeSessionId: "c-2", children: [] },
    ];

    const merged = mergeOrgWithSessions(orgRoots, [], true, {});

    expect(merged).toHaveLength(2);
    expect(merged.map((n) => n.org.name)).toEqual(["CEO", "Worker"]);
  });

  it("prunes stopped-only subtrees when sessions have loaded", () => {
    // Normal steady-state: hideStopped=true, one node matches, one doesn't.
    // The unmatched one is pruned because there's no live descendant.
    const orgRoots = [
      { name: "Live", claudeSessionId: "c-1", children: [] },
      { name: "Dead", claudeSessionId: "c-gone", children: [] },
    ];
    const sessions = [makeSession({ id: "sess-1", claudeSessionId: "c-1" })];

    const merged = mergeOrgWithSessions(orgRoots, sessions, true, {});

    expect(merged).toHaveLength(1);
    expect(merged[0].org.name).toBe("Live");
  });

  it("keeps stopped nodes when hideStopped is false", () => {
    const orgRoots = [
      { name: "Dead", claudeSessionId: "c-gone", children: [] },
    ];
    const sessions = [
      makeSession({ id: "sess-1", claudeSessionId: "c-other" }),
    ];

    const merged = mergeOrgWithSessions(orgRoots, sessions, false, {});

    expect(merged).toHaveLength(1);
    expect(merged[0].session).toBeUndefined();
  });

  it("preserves parent subtree when a child session matches by id (not name)", () => {
    // Manager in org: "lead". Worker in org: stale name "helper" but id
    // matches the current session "BackendHelper". Without id-match, the
    // worker would be pruned and if the lead had no other live children it
    // might be pruned too. Id-match keeps everything.
    const orgRoots = [
      {
        name: "lead",
        claudeSessionId: "c-lead",
        children: [
          { name: "helper", claudeSessionId: "c-worker", children: [] },
        ],
      },
    ];
    const sessions = [
      makeSession({ id: "sess-lead", claudeSessionId: "c-lead" }),
      makeSession({
        id: "sess-worker",
        name: "BackendHelper",
        claudeSessionId: "c-worker",
      }),
    ];

    const merged = mergeOrgWithSessions(orgRoots, sessions, true, {});

    expect(merged).toHaveLength(1);
    expect(merged[0].children).toHaveLength(1);
    expect(merged[0].children[0].session?.id).toBe("sess-worker");
  });
});
