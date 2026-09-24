import type { Agent } from "@autonomos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { applyAgentsSnapshot, useStore } from "./store";

/**
 * The agent row's branch arrives as a version-preserving `agent.updated`
 * patch when an agent checks out a new branch mid-session. applyAgentsSnapshot
 * short-circuits when "nothing changed" by comparing a hand-picked field list —
 * a field missing from that list is silently frozen at its page-load value
 * (the same trap that froze lastActivityAt and pendingHandoffCount). Found
 * empirically: the server emitted the patch, the open page never updated.
 */
function agent(over: Partial<Agent>): Agent {
  return {
    id: "c-1",
    name: "codex-worker-a",
    workingDirectory: "/tmp/proj",
    status: "running",
    provider: "codex",
    providerSessionId: "c-1",
    permissionMode: "ask",
    startedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    managerId: null,
    ...over,
  } as Agent;
}

beforeEach(() => {
  useStore.setState({ sessions: [], exitedSessions: [] });
});

describe("gitBranch → SessionInfo", () => {
  it("carries the server-derived branch onto the session", () => {
    applyAgentsSnapshot([agent({ gitBranch: "main" })]);
    expect(useStore.getState().sessions[0]?.gitBranch).toBe("main");
  });

  it("does NOT freeze the branch when ONLY the branch changes (short-circuit trap)", () => {
    applyAgentsSnapshot([agent({ gitBranch: "main" })]);
    // Identical in every other field — only a mid-session checkout moved.
    applyAgentsSnapshot([agent({ gitBranch: "terry/feature-x" })]);
    expect(useStore.getState().sessions[0]?.gitBranch).toBe("terry/feature-x");
  });
});
