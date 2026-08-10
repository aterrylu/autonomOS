/**
 * /ws/agents client — the push channel that retires the dashboard's agent
 * and status polls (consolidation PR A; the server side has streamed these
 * deltas into an empty client set since the channel was built).
 *
 * Design rules:
 * - RECONCILE-FIRST: every (re)connect starts with a full snapshot (agents +
 *   statuses), so the client never needs sequence numbers — a dropped or
 *   reordered delta is at worst stale until the next event or reconnect.
 * - DEGRADE, NEVER BELOW POLLING: while the socket is down, subscribers are
 *   told (`connected: false`) so they can fall back to the poll instances —
 *   a flaky network behaves like the pre-push dashboard, not worse.
 * - Reconnect uses exponential backoff WITH JITTER (the audit flagged the
 *   terminal socket's lockstep retry stampede; this channel doesn't repeat
 *   that) and an immediate retry on visibilitychange→visible.
 */

import type { Agent, AgentActivityState, AgentDelta } from "@autonomos/core";

export interface AgentsSnapshot {
  connected: boolean;
  /** Agent records by id — null until the first reconcile. */
  agents: Map<string, Agent> | null;
  /** Activity state + unread by id. */
  statuses: Map<string, { state: AgentActivityState; unread: number }>;
}

type Listener = () => void;

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

let snapshot: AgentsSnapshot = {
  connected: false,
  agents: null,
  statuses: new Map(),
};
const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let retryMs = BASE_RETRY_MS;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function emit(): void {
  for (const l of listeners) l();
}

function commit(next: Partial<AgentsSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  emit();
}

function applyDelta(delta: AgentDelta): void {
  switch (delta.type) {
    case "reconcile": {
      const agents = new Map(delta.agents.map((a) => [a.id, a]));
      const statuses = new Map(
        Object.entries(delta.statuses ?? {}).map(([id, v]) => [id, v]),
      );
      commit({ agents, statuses });
      break;
    }
    case "agent.created": {
      if (!snapshot.agents) return;
      const agents = new Map(snapshot.agents);
      agents.set(delta.agent.id, delta.agent);
      commit({ agents });
      break;
    }
    case "agent.updated":
    case "agent.reparented":
    case "agent.attached":
    case "agent.exited": {
      if (!snapshot.agents) return;
      const existing = snapshot.agents.get(delta.id);
      if (!existing) return; // unknown id — reconcile will heal
      const agents = new Map(snapshot.agents);
      if (delta.type === "agent.updated") {
        agents.set(delta.id, {
          ...existing,
          ...delta.patch,
          version: delta.version,
        });
      } else if (delta.type === "agent.reparented") {
        agents.set(delta.id, {
          ...existing,
          managerId: delta.managerId as Agent["managerId"],
          version: delta.version,
        });
      } else if (delta.type === "agent.attached") {
        agents.set(delta.id, {
          ...existing,
          status: "running",
          providerSessionId: delta.providerSessionId,
          version: delta.version,
        });
      } else {
        agents.set(delta.id, {
          ...existing,
          status: "exited",
          exitReason: delta.exitReason as Agent["exitReason"],
          version: delta.version,
        });
      }
      commit({ agents });
      break;
    }
    case "agent.deleted": {
      if (!snapshot.agents) return;
      const agents = new Map(snapshot.agents);
      agents.delete(delta.id);
      const statuses = new Map(snapshot.statuses);
      statuses.delete(delta.id);
      commit({ agents, statuses });
      break;
    }
    case "agent.status": {
      const statuses = new Map(snapshot.statuses);
      statuses.set(delta.id, { state: delta.state, unread: delta.unread });
      commit({ statuses });
      break;
    }
    default:
      // Forward-compat per the union's own contract: ignore unknown types.
      break;
  }
}

function connect(): void {
  if (ws) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws/agents`);
  ws = socket;

  socket.onopen = () => {
    retryMs = BASE_RETRY_MS;
    commit({ connected: true });
  };
  socket.onmessage = (ev) => {
    try {
      applyDelta(JSON.parse(ev.data as string) as AgentDelta);
    } catch {
      // A malformed frame is a server bug; the next reconcile heals us.
    }
  };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    commit({ connected: false });
    scheduleReconnect();
  };
  socket.onerror = () => {
    // close fires next; reconnect is scheduled there.
  };
}

function scheduleReconnect(): void {
  if (retryTimer || !started) return;
  // Jittered backoff: ±30% so N tabs reconnecting after a server restart
  // don't stampede in lockstep.
  const jitter = retryMs * (0.7 + Math.random() * 0.6);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (started) connect();
  }, jitter);
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
}

function handleVisibility(): void {
  if (document.visibilityState === "visible" && started && !ws) {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    retryMs = BASE_RETRY_MS;
    connect();
  }
}

export const agentsSocket = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    if (!started) {
      started = true;
      document.addEventListener("visibilitychange", handleVisibility);
      connect();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        started = false;
        document.removeEventListener("visibilitychange", handleVisibility);
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        ws?.close();
        ws = null;
      }
    };
  },
  getSnapshot(): AgentsSnapshot {
    return snapshot;
  },
  /** Test hook: apply a frame as if received. */
  _applyForTests(delta: AgentDelta): void {
    applyDelta(delta);
  },
};
