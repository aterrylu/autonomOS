// @vitest-environment jsdom
/**
 * agentsSocket — the /ws/agents client. The load-bearing invariant pinned
 * here: a DISCONNECT resets the baseline (agents → null), so on every
 * reconnect the "open ≠ live, requires a reconcile" guard holds — not just on
 * the first connection. Without the reset, onopen replays the stale
 * pre-disconnect snapshot as live: polls suspend early, killed agents
 * resurrect, and a stale needs_input fires a phantom desktop notification.
 */
import type { Agent } from "@autonomos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsSocket } from "./agentsSocket";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  // Test drivers
  open(): void {
    this.onopen?.();
  }
  frame(delta: unknown): void {
    this.onmessage?.({ data: JSON.stringify(delta) });
  }
  drop(): void {
    this.onclose?.();
  }
}

function agent(id: string): Agent {
  return {
    schemaVersion: 1,
    id,
    name: id,
    managerId: null,
    workingDirectory: "/tmp",
    permissionMode: "ask",
    status: "running",
    provider: "claude-code",
    providerSessionId: id,
    startedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    version: 1,
  } as Agent;
}

const state = (s: { status: string }) => ({
  status: s.status,
  lastEvent: "x",
  updatedAt: 1,
});

let unsubscribe: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("agentsSocket reconnect baseline", () => {
  it("a disconnect resets agents to null and statuses to empty — reopen is NOT live until its own reconcile", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    ws1.frame({
      type: "reconcile",
      agents: [agent("a1")],
      statuses: { a1: { state: state({ status: "needs_input" }), unread: 1 } },
    });
    expect(agentsSocket.getSnapshot().agents?.size).toBe(1);
    expect(agentsSocket.getSnapshot().statuses.size).toBe(1);

    ws1.drop();
    const afterDrop = agentsSocket.getSnapshot();
    expect(afterDrop.connected).toBe(false);
    expect(afterDrop.agents).toBeNull(); // the regression pin
    expect(afterDrop.statuses.size).toBe(0);

    // Backoff (1s ±30%) → reconnect attempt.
    vi.advanceTimersByTime(2000);
    const ws2 = FakeWebSocket.instances[1];
    expect(ws2).toBeDefined();
    ws2.open();
    const reopened = agentsSocket.getSnapshot();
    expect(reopened.connected).toBe(true);
    expect(reopened.agents).toBeNull(); // open ≠ live on RECONNECT too

    ws2.frame({ type: "reconcile", agents: [agent("a2")], statuses: {} });
    expect(agentsSocket.getSnapshot().agents?.has("a2")).toBe(true);
    expect(agentsSocket.getSnapshot().agents?.has("a1")).toBe(false);
  });

  it("a reconcile WITHOUT a statuses field keeps current statuses instead of wiping them", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    const ws = FakeWebSocket.instances[0];
    ws.open();
    ws.frame({
      type: "reconcile",
      agents: [agent("a1")],
      statuses: { a1: { state: state({ status: "working" }), unread: 0 } },
    });
    expect(agentsSocket.getSnapshot().statuses.size).toBe(1);

    ws.frame({ type: "reconcile", agents: [agent("a1")] }); // statuses absent
    expect(agentsSocket.getSnapshot().statuses.size).toBe(1); // kept, not wiped
  });
});
