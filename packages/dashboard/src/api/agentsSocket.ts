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

/**
 * Transport health, as the status-bar indicator reports it:
 * - `connecting`   — no connection has opened yet this page load.
 * - `connected`    — open, and a frame arrived within {@link STALE_AFTER_MS}.
 * - `reconnecting` — we HAD a connection and lost it (closed, or silent past
 *                    the stale window); retrying.
 * - `disconnected` — reconnecting for longer than {@link DISCONNECTED_AFTER_MS}.
 */
export type TransportHealth =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface AgentsSnapshot {
  connected: boolean;
  health: TransportHealth;
  /** Agent records by id — null until the first reconcile. */
  agents: Map<string, Agent> | null;
  /** Activity state + unread by id. */
  statuses: Map<string, { state: AgentActivityState; unread: number }>;
}

type Listener = () => void;
/** A message the gateway accepted (transient; nothing stores it). */
export type RoutedMessage = Extract<AgentDelta, { type: "message.routed" }>;
type MessageListener = (m: RoutedMessage) => void;

const BASE_RETRY_MS = 1000;
const MAX_RETRY_MS = 15_000;

let snapshot: AgentsSnapshot = {
  connected: false,
  health: "connecting",
  agents: null,
  statuses: new Map(),
};
const listeners = new Set<Listener>();
// Transient events ride their own channel: they aren't state, so they don't
// belong in the snapshot (and must not trigger snapshot re-renders).
const messageListeners = new Set<MessageListener>();
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
      // `statuses` is optional in the union for forward-compat; the server
      // always sends it today. If a future server omits it, keep what we
      // have rather than wiping every status while the status poll is
      // suspended on a "healthy" socket.
      const statuses = delta.statuses
        ? new Map(Object.entries(delta.statuses))
        : snapshot.statuses;
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
        // The delta carries the full refreshed record — apply it wholesale.
        // A field-list here silently dropped `provider` (and would have
        // dropped permissionMode/envPreset changes on resume): the socket
        // tree and the REST tree then ping-pong for the socket's lifetime,
        // because treePoll.refresh() is deliberately not suspension-gated.
        agents.set(delta.id, delta.agent);
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
    case "message.routed": {
      for (const l of messageListeners) {
        try {
          l(delta);
        } catch (err) {
          console.warn("[agentsSocket] message listener failed:", err);
        }
      }
      break;
    }
    default:
      // Forward-compat per the union's own contract: ignore unknown types.
      break;
  }
}

// Half-open detection: the server heartbeats every 2s, so a healthy socket
// is never frameless for long. An OPEN socket silent past ~2 beats (VPN drop,
// Wi-Fi switch, sleep/wake, a stalled server — TCP can take minutes to
// notice) is ABANDONED: we stop listening to it and open a fresh one at once.
// Not "close and wait for onclose" — measured on a half-open link, close()
// leaves the socket in CLOSING indefinitely and onclose never fires, so a
// reconnect gated on it never happens.
// Terry: 12s "is a little bit too long". This covers IDLE time only — while
// typing, per-keystroke acks answer within ~1s (liveTerminals.ts).
export const STALE_AFTER_MS = 5_000;
/** Reconnecting this long (since the last frame) escalates to disconnected. */
export const DISCONNECTED_AFTER_MS = 20_000;
/** A handshake that hasn't opened by then is abandoned and retried — on a
 *  half-open path the upgrade can hang with no error. */
const CONNECT_TIMEOUT_MS = 5_000;
const WATCHDOG_CHECK_MS = 500;
let lastFrameAt = 0;
let connectStartedAt = 0;
let everOpened = false;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
const healthListeners = new Set<(h: TransportHealth) => void>();

function setHealth(health: TransportHealth): void {
  if (snapshot.health === health) return;
  commit({ health });
  for (const l of healthListeners) {
    try {
      l(health);
    } catch (err) {
      console.warn("[agentsSocket] health listener threw:", err);
    }
  }
}

/** Stop listening to the current socket and reconnect NOW. Its handlers are
 *  superseded-guarded, so whatever it does later (a late close, a late
 *  frame) is ignored. */
function abandonAndReconnect(): void {
  const dead = ws;
  ws = null;
  try {
    dead?.close();
  } catch {
    // already closing
  }
  if (snapshot.connected) {
    commit({ connected: false, agents: null, statuses: new Map() });
  }
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (started) connect();
}

function watchdog(): void {
  const now = Date.now();
  if (ws && snapshot.connected && now - lastFrameAt > STALE_AFTER_MS) {
    setHealth("reconnecting");
    retryMs = BASE_RETRY_MS;
    abandonAndReconnect();
  } else if (
    ws &&
    !snapshot.connected &&
    ws.readyState === WebSocket.CONNECTING &&
    now - connectStartedAt > CONNECT_TIMEOUT_MS
  ) {
    // Hung handshake: treat like a failed attempt (backoff applies).
    const dead = ws;
    ws = null;
    try {
      dead.close();
    } catch {
      // ignore
    }
    scheduleReconnect();
  }
  if (
    snapshot.health === "reconnecting" &&
    now - lastFrameAt >= DISCONNECTED_AFTER_MS
  ) {
    setHealth("disconnected");
  }
}

function markLost(): void {
  if (everOpened) {
    setHealth(
      Date.now() - lastFrameAt >= DISCONNECTED_AFTER_MS
        ? "disconnected"
        : "reconnecting",
    );
  }
}

function handleOffline(): void {
  if (!started) return;
  // The OS says the network is gone — no need to wait out the stale window.
  if (ws && snapshot.connected) {
    markLost();
    abandonAndReconnect();
  }
}

function handleOnline(): void {
  if (!started) return;
  // Network is back: retry now instead of waiting out the backoff.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    retryMs = BASE_RETRY_MS;
    abandonAndReconnect();
  }
}

function connect(): void {
  if (ws) return;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${proto}//${location.host}/ws/agents`);
  ws = socket;
  connectStartedAt = Date.now();

  // Every handler is superseded-socket guarded (the invariant the terminal
  // socket learned the hard way): close events are ASYNC, so a torn-down
  // socket's onclose can land after a newer socket exists (StrictMode
  // mount→unmount→mount, the auth Retry re-running the bridge effect) — and
  // an unguarded handler would reset the HEALTHY connection's baseline or
  // re-arm a reconnect loop against it.
  socket.onopen = () => {
    if (ws !== socket) return;
    retryMs = BASE_RETRY_MS;
    lastFrameAt = Date.now();
    everOpened = true;
    commit({ connected: true });
    setHealth("connected");
  };
  socket.onmessage = (ev) => {
    if (ws !== socket) return;
    lastFrameAt = Date.now();
    try {
      applyDelta(JSON.parse(ev.data as string) as AgentDelta);
    } catch {
      // A malformed frame is a server bug; the next reconcile heals us.
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    // Reset the baseline, not just the flag: a REconnect fires onopen before
    // its reconcile arrives, and a kept map would make the bridge treat the
    // stale pre-disconnect snapshot as live — suspending polls and replaying
    // outdated statuses (a phantom needs_input desktop notification, killed
    // agents briefly resurrected). `agents: null` re-arms the "open ≠ live"
    // guard for every connection, not just the first.
    commit({ connected: false, agents: null, statuses: new Map() });
    markLost();
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
  if (document.visibilityState !== "visible" || !started) return;
  // Wake/return with a socket that still LOOKS open: check staleness now
  // rather than waiting a watchdog cycle — sleep froze the timers too.
  watchdog();
  if (!ws) {
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
      // A fresh start gets a fresh backoff — not whatever the previous
      // subscription's failures had grown it to.
      retryMs = BASE_RETRY_MS;
      document.addEventListener("visibilitychange", handleVisibility);
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      watchdogTimer = setInterval(watchdog, WATCHDOG_CHECK_MS);
      connect();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        started = false;
        document.removeEventListener("visibilitychange", handleVisibility);
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
        if (watchdogTimer) {
          clearInterval(watchdogTimer);
          watchdogTimer = null;
        }
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        // Detach BEFORE closing, so the superseded guard below holds by
        // construction rather than by onclose happening to be async.
        const closing = ws;
        ws = null;
        closing?.close();
        // The closed socket's onclose is superseded-guarded (ws is already
        // null ≠ socket), so IT won't reset the baseline — do it here, or a
        // resubscribe would treat this stale snapshot as live before the new
        // connection's reconcile lands.
        everOpened = false;
        commit({ connected: false, agents: null, statuses: new Map() });
        // Through setHealth, not commit: onHealthChange listeners (the status
        // bar, the terminal cache's transport view) must hear this too, or
        // they keep a stale "connected" while no socket exists.
        setHealth("connecting");
      }
    };
  },
  /** Accepted agent-to-agent messages as they happen (the Org Chart's
   *  message flow). Only delivered while something also `subscribe`s — the
   *  push bridge keeps the socket open for the whole dashboard session. */
  onMessageRouted(listener: MessageListener): () => void {
    messageListeners.add(listener);
    return () => {
      messageListeners.delete(listener);
    };
  },
  getSnapshot(): AgentsSnapshot {
    return snapshot;
  },
  /** Epoch ms of the last frame (heartbeat or delta); 0 before the first. */
  lastHeardAt(): number {
    return lastFrameAt;
  },
  /** Observe health transitions WITHOUT holding the socket open (unlike
   *  subscribe) — the terminal cache reconnects its panes on recovery. */
  onHealthChange(listener: (h: TransportHealth) => void): () => void {
    healthListeners.add(listener);
    return () => {
      healthListeners.delete(listener);
    };
  },
  /** Test hook: apply a frame as if received. */
  _applyForTests(delta: AgentDelta): void {
    applyDelta(delta);
  },
};
