// @vitest-environment jsdom
/**
 * Push bridge: while the /ws/agents socket is live it must (1) suspend the
 * agents/tree/status polls, (2) translate socket snapshots through the SAME
 * apply paths the polls used, and (3) hand back to polling the moment the
 * socket drops. The tree derivation must match the server's buildAgentTree.
 */
import type { Agent } from "@autonomos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Controllable fake socket — the bridge only uses subscribe/getSnapshot.
const fakeSocket = {
  snapshot: {
    connected: false,
    agents: null as Map<string, Agent> | null,
    statuses: new Map<string, { state: { status: string }; unread: number }>(),
  },
  listeners: new Set<() => void>(),
  subscribe(l: () => void) {
    fakeSocket.listeners.add(l);
    return () => fakeSocket.listeners.delete(l);
  },
  getSnapshot() {
    return fakeSocket.snapshot;
  },
  emit() {
    for (const l of fakeSocket.listeners) l();
  },
};

vi.mock("./api/agentsSocket", () => ({ agentsSocket: fakeSocket }));

const pollStub = () => ({
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => ({ data: null, error: null })),
  refresh: vi.fn(async () => {}),
  setSuspended: vi.fn(),
  inject: vi.fn(),
});
vi.mock("./api/polls", () => ({
  agentsPoll: pollStub(),
  treePoll: pollStub(),
  statusPoll: pollStub(),
}));

vi.mock("./store", () => ({
  applyAgentsSnapshot: vi.fn(),
  applyStatusSnapshot: vi.fn(),
}));

const { agentsPoll, statusPoll, treePoll } = await import("./api/polls");
const { applyAgentsSnapshot, applyStatusSnapshot } = await import("./store");
const { buildTreeFromAgents, startPushBridge } = await import("./pushBridge");

function agent(partial: Partial<Agent> & { id: string }): Agent {
  return {
    schemaVersion: 1,
    name: partial.id,
    managerId: null,
    workingDirectory: "/tmp",
    permissionMode: "ask",
    status: "running",
    provider: "claude-code",
    providerSessionId: partial.id,
    startedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
    ...partial,
  } as Agent;
}

let stop: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  fakeSocket.snapshot = { connected: false, agents: null, statuses: new Map() };
});
afterEach(() => {
  stop?.();
  stop = null;
});

describe("buildTreeFromAgents (server buildAgentTree parity)", () => {
  it("running-only filter, children under visible managers, orphans promoted", () => {
    const lead = agent({ id: "lead" });
    const worker = agent({ id: "worker", managerId: "lead" });
    const orphan = agent({ id: "orphan", managerId: "dead-mgr" });
    const exited = agent({ id: "gone", status: "exited" });
    const tree = buildTreeFromAgents([lead, worker, orphan, exited]);
    expect(tree.map((n) => n.id)).toEqual(["lead", "orphan"]);
    expect(tree[0].children.map((n) => n.id)).toEqual(["worker"]);
    // Field parity with the /tree route's mapNode.
    expect(tree[0]).toMatchObject({
      id: "lead",
      claudeSessionId: "lead",
      name: "lead",
      status: "running",
      provider: "claude-code",
      permissionMode: "ask",
    });
  });

  it("a child of an EXITED manager becomes a root (manager filtered out)", () => {
    const mgr = agent({ id: "mgr", status: "exited" });
    const child = agent({ id: "child", managerId: "mgr" });
    const tree = buildTreeFromAgents([mgr, child]);
    expect(tree.map((n) => n.id)).toEqual(["child"]);
  });
});

describe("startPushBridge", () => {
  it("does nothing while the socket has no reconcile (open ≠ live)", () => {
    fakeSocket.snapshot = {
      connected: true,
      agents: null,
      statuses: new Map(),
    };
    stop = startPushBridge();
    expect(agentsPoll.setSuspended).not.toHaveBeenCalledWith(true);
    expect(applyAgentsSnapshot).not.toHaveBeenCalled();
  });

  it("live snapshot suspends all three polls and feeds store + poll snapshots", () => {
    const a = agent({ id: "a1" });
    fakeSocket.snapshot = {
      connected: true,
      agents: new Map([[a.id, a]]),
      statuses: new Map([["a1", { state: { status: "working" }, unread: 2 }]]),
    };
    stop = startPushBridge();
    expect(agentsPoll.setSuspended).toHaveBeenCalledWith(true);
    expect(treePoll.setSuspended).toHaveBeenCalledWith(true);
    expect(statusPoll.setSuspended).toHaveBeenCalledWith(true);
    expect(applyAgentsSnapshot).toHaveBeenCalledWith([a]);
    // WS `state` field → REST map `status` field translation.
    expect(applyStatusSnapshot).toHaveBeenCalledWith({
      a1: { status: { status: "working" }, unread: 2 },
    });
    expect(agentsPoll.inject).toHaveBeenCalledWith([a]);
    expect(treePoll.inject).toHaveBeenCalledWith(buildTreeFromAgents([a]));
  });

  it("socket drop resumes polling (degrade, never below)", () => {
    const a = agent({ id: "a1" });
    fakeSocket.snapshot = {
      connected: true,
      agents: new Map([[a.id, a]]),
      statuses: new Map(),
    };
    stop = startPushBridge();
    fakeSocket.snapshot = { ...fakeSocket.snapshot, connected: false };
    fakeSocket.emit();
    expect(agentsPoll.setSuspended).toHaveBeenLastCalledWith(false);
    expect(treePoll.setSuspended).toHaveBeenLastCalledWith(false);
    expect(statusPoll.setSuspended).toHaveBeenLastCalledWith(false);
  });

  it("stop() unsuspends and unsubscribes", () => {
    const a = agent({ id: "a1" });
    fakeSocket.snapshot = {
      connected: true,
      agents: new Map([[a.id, a]]),
      statuses: new Map(),
    };
    stop = startPushBridge();
    stop();
    stop = null;
    expect(agentsPoll.setSuspended).toHaveBeenLastCalledWith(false);
    expect(fakeSocket.listeners.size).toBe(0);
  });
});
