/**
 * Gateway Router — routes messages between platform adapters and CC sessions.
 *
 * The router is stateless (no message persistence). If a session is down,
 * messages are dropped. CC owns its own conversation history.
 */

import type {
  ChannelRoute,
  GatewayMessage,
  GatewayReply,
  GatewayWsMessage,
  PlatformAdapter,
} from "@autonomos/core";
import type { WSContext } from "hono/ws";
import { getAllSessions } from "../sessions.js";
import { batchGetTitles } from "../titleCache.js";

// ── Registry ──────────────────────────────────────────────────────

/** Connected channel MCP server WebSockets, keyed by autonomOS session ID */
const sessionClients = new Map<string, WSContext>();

/** Connected dashboard WebSockets (for observability — all messages fanned out) */
const dashboardClients = new Set<WSContext>();

/** Platform adapters, keyed by platform name */
const adapters = new Map<string, PlatformAdapter>();

/** Routing table: (platform, chatId) → sessionId */
let routes: ChannelRoute[] = [];

// ── Public API ────────────────────────────────────────────────────

export function registerSessionClient(sessionId: string, ws: WSContext): void {
  sessionClients.set(sessionId, ws);
  console.log(`[gateway] session ${sessionId} connected`);
}

export function unregisterSessionClient(ws: WSContext): void {
  for (const [id, client] of sessionClients) {
    if (client === ws) {
      sessionClients.delete(id);
      console.log(`[gateway] session ${id} disconnected`);
      break;
    }
  }
}

export function registerDashboard(ws: WSContext): void {
  dashboardClients.add(ws);
}

export function unregisterDashboard(ws: WSContext): void {
  dashboardClients.delete(ws);
}

export function registerAdapter(adapter: PlatformAdapter): void {
  adapters.set(adapter.platform, adapter);
  adapter.onMessage((msg) => routeInbound(msg));
}

export function setRoutes(newRoutes: ChannelRoute[]): void {
  routes = newRoutes;
}

export function getRoutes(): ChannelRoute[] {
  return routes;
}

// ── Inbound: platform → CC session ────────────────────────────────

function routeInbound(msg: GatewayMessage): void {
  // Fan out to dashboard for observability
  fanOutToDashboard({ type: "message", payload: msg });

  // Find route
  const route = routes.find(
    (r) => r.platform === msg.platform && r.chatId === msg.chatId,
  );

  if (!route) {
    console.log(
      `[gateway] no route for ${msg.platform}:${msg.chatId} — dropping`,
    );
    return;
  }

  const client = sessionClients.get(route.sessionId);
  if (!client) {
    console.log(
      `[gateway] session ${route.sessionId} not connected — dropping message from ${msg.platform}:${msg.chatId}`,
    );
    return;
  }

  const wsMsg: GatewayWsMessage = { type: "message", payload: msg };
  try {
    client.send(JSON.stringify(wsMsg));
  } catch (err) {
    console.error(
      `[gateway] failed to send to session ${route.sessionId}:`,
      err,
    );
  }
}

// ── Outbound: CC session → platform ───────────────────────────────

export function routeReply(reply: GatewayReply): void {
  // Fan out to dashboard
  fanOutToDashboard({ type: "reply", payload: reply });

  const adapter = adapters.get(reply.platform);
  if (!adapter) {
    console.log(`[gateway] no adapter for platform: ${reply.platform}`);
    return;
  }

  if (!adapter.isConnected()) {
    console.log(`[gateway] ${reply.platform} adapter not connected`);
    return;
  }

  adapter.send(reply).catch((err) => {
    console.error(`[gateway] ${reply.platform} send failed:`, err);
  });
}

// ── Inter-agent: CC session → CC session ──────────────────────────

/** Resolve a target by ID or name. Returns [sessionId, WSContext] or null. */
function resolveTarget(idOrName: string): [string, WSContext] | null {
  // Exact ID match
  const byId = sessionClients.get(idOrName);
  if (byId) return [idOrName, byId];

  // Name match (case-insensitive)
  const sessions = getAllSessions();
  const exact = sessions.find(
    (s) => s.name.toLowerCase() === idOrName.toLowerCase(),
  );
  if (exact) {
    const ws = sessionClients.get(exact.id);
    if (ws) return [exact.id, ws];
  }

  // Partial name match
  const partial = sessions.find((s) =>
    s.name.toLowerCase().includes(idOrName.toLowerCase()),
  );
  if (partial) {
    const ws = sessionClients.get(partial.id);
    if (ws) return [partial.id, ws];
  }

  return null;
}

export function routeToAgent(
  fromSessionId: string,
  targetIdOrName: string,
  content: string,
): void {
  const resolved = resolveTarget(targetIdOrName);
  if (!resolved) {
    console.log(
      `[gateway] target "${targetIdOrName}" not found or not connected — dropping inter-agent message`,
    );
    return;
  }
  const [targetSessionId, target] = resolved;

  // Inter-agent messages reuse GatewayMessage with a synthetic chatId.
  // Platform is set to "discord" as a placeholder — the channel server
  // identifies the source via the "agent:" prefix in chatId.
  const msg: GatewayMessage = {
    id: crypto.randomUUID(),
    platform: "discord",
    platformMessageId: "",
    chatId: `agent:${fromSessionId}`,
    userId: fromSessionId,
    userName: `Session ${fromSessionId.slice(0, 8)}`,
    text: content,
    timestamp: Date.now(),
  };

  const wsMsg: GatewayWsMessage = { type: "message", payload: msg };
  try {
    target.send(JSON.stringify(wsMsg));
  } catch (err) {
    console.error(
      `[gateway] failed to send to target session ${targetSessionId}:`,
      err,
    );
  }

  // Fan out to dashboard
  fanOutToDashboard(wsMsg);
}

// ── Agent discovery ───────────────────────────────────────────────

export async function getAgentList(): Promise<
  Array<{ sessionId: string; name: string; status: string }>
> {
  const sessions = getAllSessions();

  // Enrich names with titleCache (same logic as GET /api/sessions)
  const withClaude = sessions
    .filter((s) => s.claudeSessionId)
    .map((s) => ({ sessionId: s.claudeSessionId!, cwd: s.workingDirectory }));

  let titles = new Map<string, string>();
  if (withClaude.length > 0) {
    try {
      titles = await batchGetTitles(withClaude);
    } catch {
      // best-effort — fall back to spawn-time name
    }
  }

  return sessions.map((s) => ({
    sessionId: s.id,
    name: (s.claudeSessionId && titles.get(s.claudeSessionId)) ?? s.name,
    status: s.status,
  }));
}

// ── Dashboard fan-out ─────────────────────────────────────────────

function fanOutToDashboard(msg: GatewayWsMessage): void {
  const json = JSON.stringify(msg);
  for (const client of dashboardClients) {
    try {
      client.send(json);
    } catch (err) {
      console.warn("[gateway] dashboard client send failed, removing:", err);
      dashboardClients.delete(client);
    }
  }
}
