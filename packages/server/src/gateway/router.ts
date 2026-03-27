/**
 * Gateway Router — routes messages between platform adapters and CC sessions.
 *
 * Uses URI-based addressing: agent://name, discord://guild/channel, broadcast://all.
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

// ── URI-based message routing ─────────────────────────────────────

/**
 * Route a message by URI. Returns an error string if routing fails, null on success.
 */
export function routeMessage(
  to: string,
  message: string,
  fromSessionId: string,
): string | null {
  const sepIndex = to.indexOf("://");
  if (sepIndex === -1) {
    return `Invalid URI: "${to}" — expected scheme://path (e.g. agent://name)`;
  }

  const scheme = to.slice(0, sepIndex);
  const path = to.slice(sepIndex + 3);

  switch (scheme) {
    case "agent":
      return routeToAgent(fromSessionId, path, message);

    case "discord":
    case "telegram":
    case "slack":
      return routeToPlatform(scheme, path, message);

    case "broadcast":
      broadcastToAllAgents(fromSessionId, message);
      return null;

    default:
      return `Unknown URI scheme: "${scheme}" — supported: agent, discord, telegram, slack, broadcast`;
  }
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

// ── Agent routing ─────────────────────────────────────────────────

/** Resolve agent by name. Exact case-insensitive match only. */
function resolveAgent(name: string): [string, WSContext] | null {
  // Exact session ID match
  const byId = sessionClients.get(name);
  if (byId) return [name, byId];

  // Exact name match (case-insensitive)
  const sessions = getAllSessions();
  const match = sessions.find(
    (s) => s.name.toLowerCase() === name.toLowerCase(),
  );
  if (match) {
    const ws = sessionClients.get(match.id);
    if (ws) return [match.id, ws];
  }

  return null;
}

/** Resolve the display name for a session ID (enriched via titleCache) */
async function resolveSessionName(sessionId: string): Promise<string> {
  const session = getAllSessions().find((s) => s.id === sessionId);
  if (!session) return `Agent ${sessionId.slice(0, 8)}`;

  if (session.claudeSessionId) {
    try {
      const titles = await batchGetTitles([
        { sessionId: session.claudeSessionId, cwd: session.workingDirectory },
      ]);
      const title = titles.get(session.claudeSessionId);
      if (title) return title;
    } catch {
      // fall back to spawn-time name
    }
  }

  return session.name;
}

function routeToAgent(
  fromSessionId: string,
  targetName: string,
  content: string,
): string | null {
  const resolved = resolveAgent(targetName);
  if (!resolved) {
    console.log(`[gateway] agent "${targetName}" not found or not connected`);
    return `Agent "${targetName}" not found or not connected. Use list_agents to see available agents.`;
  }
  const [targetSessionId, target] = resolved;

  // Self-send guard
  if (targetSessionId === fromSessionId) {
    return "Cannot send to yourself.";
  }

  // Resolve sender name asynchronously — deliver message with best-effort name
  resolveSessionName(fromSessionId).then((senderName) => {
    const msg: GatewayMessage = {
      id: crypto.randomUUID(),
      platform: "discord", // unused for agent messages — fromUri is the source of truth
      platformMessageId: "",
      chatId: "",
      userId: fromSessionId,
      userName: senderName,
      text: content,
      fromUri: `agent://${senderName}`,
      timestamp: Date.now(),
    };

    const wsMsg: GatewayWsMessage = { type: "message", payload: msg };
    try {
      target.send(JSON.stringify(wsMsg));
    } catch (err) {
      console.error(`[gateway] failed to send to agent ${targetName}:`, err);
    }
    fanOutToDashboard(wsMsg);
  });

  return null;
}

// ── Platform routing ──────────────────────────────────────────────

function routeToPlatform(
  platform: string,
  path: string,
  message: string,
): string | null {
  const adapter = adapters.get(platform);
  if (!adapter) {
    return `${platform} adapter not available`;
  }
  if (!adapter.isConnected()) {
    return `${platform} adapter not connected`;
  }

  adapter
    .send({
      platform: platform as "discord" | "telegram" | "slack",
      chatId: path,
      text: message,
    })
    .catch((err) => {
      console.error(`[gateway] ${platform} send failed:`, err);
    });

  return null;
}

// ── Broadcast ─────────────────────────────────────────────────────

function broadcastToAllAgents(fromSessionId: string, content: string): void {
  resolveSessionName(fromSessionId).then((senderName) => {
    const msg: GatewayMessage = {
      id: crypto.randomUUID(),
      platform: "discord",
      platformMessageId: "",
      chatId: "",
      userId: fromSessionId,
      userName: senderName,
      text: content,
      fromUri: `agent://${senderName}`,
      timestamp: Date.now(),
    };

    const wsMsg: GatewayWsMessage = { type: "message", payload: msg };
    const json = JSON.stringify(wsMsg);

    for (const [sessionId, client] of sessionClients) {
      if (sessionId === fromSessionId) continue; // don't broadcast to self
      try {
        client.send(json);
      } catch {
        // best effort
      }
    }
    fanOutToDashboard(wsMsg);
  });
}

// ── Agent discovery ───────────────────────────────────────────────

export async function getAgentList(): Promise<
  Array<{ sessionId: string; name: string; uri: string; status: string }>
> {
  const sessions = getAllSessions();

  const withClaude = sessions
    .filter((s) => s.claudeSessionId)
    .map((s) => ({
      sessionId: s.claudeSessionId!,
      cwd: s.workingDirectory,
    }));

  let titles = new Map<string, string>();
  if (withClaude.length > 0) {
    try {
      titles = await batchGetTitles(withClaude);
    } catch {
      // best-effort
    }
  }

  return sessions.map((s) => {
    const name = (s.claudeSessionId && titles.get(s.claudeSessionId)) ?? s.name;
    return {
      sessionId: s.id,
      name,
      uri: `agent://${name}`,
      status: s.status,
    };
  });
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
