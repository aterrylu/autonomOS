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
  // EVERY constant the code compares against must exist on the fake: a
  // missing CONNECTING makes `readyState === WebSocket.CONNECTING` compare
  // undefined === undefined — vacuously true.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  url: string;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  /** Model a HALF-OPEN link: close() never completes — measured in Chrome,
   *  the socket sits in CLOSING and onclose never fires. */
  halfOpen = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  close(): void {
    this.closed = true;
    if (this.halfOpen) {
      this.readyState = FakeWebSocket.CLOSING;
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  // Test drivers
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  frame(delta: unknown): void {
    this.onmessage?.({ data: JSON.stringify(delta) });
  }
  drop(): void {
    this.readyState = FakeWebSocket.CLOSED;
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
  // Backoff jitter is Math.random — pin it so retry timing is deterministic.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

  it("watchdog abandons a half-open socket within the 5s stale window and reconnects WITHOUT waiting for onclose", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    const ws1 = FakeWebSocket.instances[0];
    ws1.halfOpen = true; // close() will never complete
    ws1.open();
    ws1.frame({ type: "reconcile", agents: [agent("a1")], statuses: {} });
    expect(agentsSocket.getSnapshot().health).toBe("connected");

    // 4.5s of silence: still inside the window (2 missed 2s beats + slack).
    vi.advanceTimersByTime(4_500);
    expect(ws1.closed).toBe(false);
    expect(agentsSocket.getSnapshot().health).toBe("connected");

    vi.advanceTimersByTime(1_000);
    expect(ws1.closed).toBe(true);
    const snap = agentsSocket.getSnapshot();
    expect(snap.health).toBe("reconnecting");
    expect(snap.connected).toBe(false);
    expect(snap.agents).toBeNull(); // baseline reset too
    // The regression pin: a replacement socket exists even though ws1's
    // onclose never fired (the old code waited for it — forever, on a
    // half-open link).
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("heartbeat frames at the 2s cadence keep a healthy socket alive", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    ws1.frame({ type: "reconcile", agents: [agent("a1")], statuses: {} });

    for (let i = 0; i < 90; i++) {
      vi.advanceTimersByTime(2_000);
      ws1.frame({ type: "ping", ts: i });
    }
    expect(ws1.closed).toBe(false);
    expect(agentsSocket.getSnapshot().health).toBe("connected");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("health: connecting → connected → reconnecting → disconnected (20s silent) → connected", () => {
    const seen: string[] = [];
    const off = agentsSocket.onHealthChange((h) => seen.push(h));
    try {
      unsubscribe = agentsSocket.subscribe(() => {});
      expect(agentsSocket.getSnapshot().health).toBe("connecting");
      const ws1 = FakeWebSocket.instances[0];
      ws1.open();
      ws1.drop(); // a real close
      expect(agentsSocket.getSnapshot().health).toBe("reconnecting");
      // Every retry fails to open; 20s after the last frame → disconnected.
      vi.advanceTimersByTime(21_000);
      expect(agentsSocket.getSnapshot().health).toBe("disconnected");
      // The CURRENT attempt — earlier retries may already have been
      // abandoned by the handshake timeout (their onopen is superseded).
      const latest = FakeWebSocket.instances.filter((w) => !w.closed).at(-1)!;
      latest.open();
      expect(agentsSocket.getSnapshot().health).toBe("connected");
      expect(seen).toEqual([
        "connected",
        "reconnecting",
        "disconnected",
        "connected",
      ]);
    } finally {
      off();
    }
  });

  it("a failure BEFORE the first open stays 'connecting' (never claims we lost something we never had)", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    FakeWebSocket.instances[0].drop();
    expect(agentsSocket.getSnapshot().health).toBe("connecting");
  });

  it("a hung handshake is abandoned after the connect timeout and retried", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    const ws1 = FakeWebSocket.instances[0];
    ws1.halfOpen = true;
    // Never opens, never errors: the upgrade hung on a half-open path.
    vi.advanceTimersByTime(4_000);
    expect(ws1.closed).toBe(false);
    vi.advanceTimersByTime(1_500);
    expect(ws1.closed).toBe(true);
    vi.advanceTimersByTime(2_000); // backoff (1s ±30%)
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
  });

  it("an OPEN socket is never mistaken for a hung handshake", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(2_000);
      ws1.frame({ type: "ping", ts: i });
    }
    expect(ws1.closed).toBe(false);
  });

  it("the browser's offline event marks reconnecting immediately; online retries at once", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    const ws1 = FakeWebSocket.instances[0];
    ws1.halfOpen = true;
    ws1.open();
    window.dispatchEvent(new Event("offline"));
    expect(agentsSocket.getSnapshot().health).toBe("reconnecting");
    const afterOffline = FakeWebSocket.instances.length;
    // The replacement attempt fails while offline…
    FakeWebSocket.instances.at(-1)!.drop();
    // …and `online` retries NOW, not after the backoff.
    window.dispatchEvent(new Event("online"));
    expect(FakeWebSocket.instances.length).toBeGreaterThan(afterOffline);
  });

  it("unsubscribing tells health listeners (they must not keep a stale 'connected')", () => {
    const seen: string[] = [];
    const off = agentsSocket.onHealthChange((h) => seen.push(h));
    try {
      const unsub = agentsSocket.subscribe(() => {});
      FakeWebSocket.instances[0].open();
      unsub();
      expect(seen).toEqual(["connected", "connecting"]);
    } finally {
      off();
    }
  });

  it("lastHeardAt tracks the latest frame, heartbeats included", () => {
    unsubscribe = agentsSocket.subscribe(() => {});
    const ws1 = FakeWebSocket.instances[0];
    ws1.open();
    vi.advanceTimersByTime(4_000);
    ws1.frame({ type: "ping", ts: 1 });
    expect(agentsSocket.lastHeardAt()).toBe(Date.now());
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
