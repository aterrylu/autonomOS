import type { Agent } from "@autonomos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAgentsSnapshot, useStore } from "./store";

function agent(partial: Partial<Agent> & { id: string }): Agent {
  return {
    schemaVersion: 1,
    name: partial.id,
    managerId: null,
    workingDirectory: "/tmp",
    permissionMode: "ask",
    status: "running",
    provider: "gemini-cli",
    providerSessionId: partial.id,
    startedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...partial,
  } as Agent;
}

beforeEach(() => {
  useStore.setState({ sessions: [], exitedSessions: [], projects: [] });
});

describe("pendingHandoffCount → SessionInfo", () => {
  it("carries the field from the agent snapshot into the view model", () => {
    applyAgentsSnapshot([agent({ id: "gigi", pendingHandoffCount: 3 })]);
    const s = useStore.getState().sessions.find((x) => x.id === "gigi");
    expect(s?.pendingHandoffCount).toBe(3);
  });

  it("does NOT freeze the badge when ONLY the pending count changes (the #340 short-circuit trap)", () => {
    // First snapshot: 2 pending.
    applyAgentsSnapshot([agent({ id: "gigi", pendingHandoffCount: 2 })]);
    expect(
      useStore.getState().sessions.find((x) => x.id === "gigi")
        ?.pendingHandoffCount,
    ).toBe(2);

    // Second snapshot: IDENTICAL in every field the short-circuit compares
    // (id/name/status/claudeSessionId/lastActivityAt) — only the pending count
    // moved. If the `unchanged` predicate ignores pendingHandoffCount, the
    // store keeps the stale array and the badge freezes at 2.
    applyAgentsSnapshot([agent({ id: "gigi", pendingHandoffCount: 5 })]);
    expect(
      useStore.getState().sessions.find((x) => x.id === "gigi")
        ?.pendingHandoffCount,
    ).toBe(5);
  });

  it("clears the badge when the count drops to 0/undefined", () => {
    applyAgentsSnapshot([agent({ id: "gigi", pendingHandoffCount: 1 })]);
    applyAgentsSnapshot([
      agent({ id: "gigi", pendingHandoffCount: undefined }),
    ]);
    expect(
      useStore.getState().sessions.find((x) => x.id === "gigi")
        ?.pendingHandoffCount,
    ).toBeUndefined();
  });
});
