/**
 * Gateway Router — routes messages between platform adapters and CC sessions.
 *
 * Uses URI-based addressing: agent://name, discord://guild/channel, broadcast://all.
 * The router is stateless (no message persistence). If a session is down,
 * messages are dropped. CC owns its own conversation history.
 */

import type {
  AgentInfo,
  ChannelRoute,
  GatewayMessage,
  GatewayWsMessage,
  Platform,
  PlatformAdapter,
} from "@autonomos/core";
import type { WSContext } from "hono/ws";
import { getAgent, listAgents, resolveAgentByName } from "../agents/store.js";
import { recordEvent } from "../memory/events.js";
import { batchGetTitles } from "../titleCache.js";

// ── Registry ──────────────────────────────────────────────────────

/** Connected channel MCP server WebSockets, keyed by autonomOS agent id. */
const sessionClients = new Map<string, WSContext>();

/** Connected dashboard WebSockets (for observability — all messages fanned out) */
const dashboardClients = new Set<WSContext>();

/** Platform adapters, keyed by platform name */
const adapters = new Map<string, PlatformAdapter>();

/** Routing table: (platform, chatId) → agent id */
let routes: ChannelRoute[] = [];

// ── Public API ────────────────────────────────────────────────────

export function registerSessionClient(sessionId: string, ws: WSContext): void {
  sessionClients.set(sessionId, ws);
  console.log(`[gateway] agent ${sessionId} connected`);
}

export function unregisterSessionClient(ws: WSContext): void {
  for (const [id, client] of sessionClients) {
    if (client === ws) {
      sessionClients.delete(id);
      console.log(`[gateway] agent ${id} disconnected`);
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
export async function routeMessage(
  to: string,
  message: string,
  fromSessionId: string,
): Promise<string | null> {
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
  fanOutToDashboard({ type: "message", payload: msg });

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
      `[gateway] agent ${route.sessionId} not connected — dropping message from ${msg.platform}:${msg.chatId}`,
    );
    return;
  }

  const wsMsg: GatewayWsMessage = { type: "message", payload: msg };
  try {
    client.send(JSON.stringify(wsMsg));
  } catch (err) {
    console.error(`[gateway] failed to send to agent ${route.sessionId}:`, err);
  }
}

// ── Agent routing ─────────────────────────────────────────────────

/**
 * Resolve agent by id-or-name. Returns [agentId, ws] on success.
 */
async function resolveConnectedAgent(
  idOrName: string,
): Promise<[string, WSContext] | null> {
  // Exact id match (UUID)
  const byId = sessionClients.get(idOrName);
  if (byId) return [idOrName, byId];

  // Direct name match via store (case-insensitive, prefer running)
  const direct = resolveAgentByName(idOrName);
  if (direct) {
    const ws = sessionClients.get(direct.id);
    if (ws) return [direct.id, ws];
  }

  // Title-resolved name (from JSONL — handles /rename windows where the
  // store hasn't picked up the new name yet).
  const all = listAgents().filter((a) => a.providerSessionId);
  const lookups = all.map((a) => ({
    sessionId: a.providerSessionId,
    cwd: a.workingDirectory,
  }));
  if (lookups.length > 0) {
    const titles = await batchGetTitles(lookups).catch(
      () => new Map<string, string>(),
    );
    const needle = idOrName.toLowerCase();
    for (const a of all) {
      const resolved = titles.get(a.providerSessionId) ?? a.name;
      if (resolved.toLowerCase() === needle) {
        const ws = sessionClients.get(a.id);
        if (ws) return [a.id, ws];
      }
    }
  }

  return null;
}

/** Resolve the display name for an agent id (enriched via titleCache) */
async function resolveAgentName(agentId: string): Promise<string> {
  const agent = getAgent(agentId);
  if (!agent) return `Agent ${agentId.slice(0, 8)}`;

  if (agent.providerSessionId) {
    const titles = await batchGetTitles([
      { sessionId: agent.providerSessionId, cwd: agent.workingDirectory },
    ]).catch((err) => {
      console.warn(`[gateway] title resolution failed:`, err);
      return new Map<string, string>();
    });
    const title = titles.get(agent.providerSessionId);
    if (title) return title;
  }

  return agent.name;
}

/** Build a GatewayMessage for agent-to-agent communication */
function buildAgentMessage(
  senderId: string,
  senderName: string,
  text: string,
): GatewayMessage {
  return {
    id: crypto.randomUUID(),
    platform: "discord", // unused for agent messages — fromUri is the source of truth
    platformMessageId: "",
    chatId: "",
    userId: senderId,
    userName: senderName,
    text,
    fromUri: `agent://${senderName}`,
    timestamp: Date.now(),
  };
}

async function routeToAgent(
  fromSessionId: string,
  targetName: string,
  content: string,
): Promise<string | null> {
  const resolved = await resolveConnectedAgent(targetName);
  if (!resolved) {
    console.log(`[gateway] agent "${targetName}" not found or not connected`);
    return `Agent "${targetName}" not found or not connected. Use list_agents to see available agents.`;
  }
  const [targetSessionId, target] = resolved;

  if (targetSessionId === fromSessionId) {
    return "Cannot send to yourself.";
  }

  const senderName = await resolveAgentName(fromSessionId);
  const wsMsg: GatewayWsMessage = {
    type: "message",
    payload: buildAgentMessage(fromSessionId, senderName, content),
  };
  try {
    target.send(JSON.stringify(wsMsg));
  } catch (err) {
    console.error(`[gateway] failed to send to agent ${targetName}:`, err);
    return `Failed to deliver message to agent "${targetName}"`;
  }
  fanOutToDashboard(wsMsg);

  recordEvent({
    type: "agent_message",
    actorAgentId: fromSessionId,
    summary: `→ agent://${targetName}: ${content}`,
    refs: { agentIds: [targetSessionId] },
    payload: { to: `agent://${targetName}`, content },
  });

  return null;
}

// ── Platform routing ──────────────────────────────────────────────

function routeToPlatform(
  platform: Platform,
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

  adapter.send({ platform, chatId: path, text: message }).catch((err) => {
    console.error(`[gateway] ${platform} send failed:`, err);
  });

  return null;
}

// ── Broadcast ─────────────────────────────────────────────────────

function broadcastToAllAgents(fromSessionId: string, content: string): void {
  resolveAgentName(fromSessionId).then((senderName) => {
    const wsMsg: GatewayWsMessage = {
      type: "message",
      payload: buildAgentMessage(fromSessionId, senderName, content),
    };
    const json = JSON.stringify(wsMsg);

    const delivered: string[] = [];
    for (const [sessionId, client] of sessionClients) {
      if (sessionId === fromSessionId) continue;
      try {
        client.send(json);
        delivered.push(sessionId);
      } catch (err) {
        console.warn(
          `[gateway] broadcast to agent ${sessionId} failed, removing:`,
          err,
        );
        sessionClients.delete(sessionId);
      }
    }
    fanOutToDashboard(wsMsg);

    recordEvent({
      type: "agent_message",
      actorAgentId: fromSessionId,
      summary: `→ broadcast://all (${delivered.length} recipients): ${content}`,
      refs: { agentIds: delivered },
      payload: { to: "broadcast://all", content },
    });
  });
}

// ── Agent discovery ───────────────────────────────────────────────

export async function getAgentList(): Promise<AgentInfo[]> {
  const agents = listAgents().filter((a) => a.status === "running");

  const lookups = agents
    .filter((a) => a.providerSessionId)
    .map((a) => ({
      sessionId: a.providerSessionId,
      cwd: a.workingDirectory,
    }));

  const titles =
    lookups.length > 0
      ? await batchGetTitles(lookups).catch(() => new Map<string, string>())
      : new Map<string, string>();

  return agents.map((a) => {
    const name = titles.get(a.providerSessionId) ?? a.name;
    return {
      sessionId: a.id,
      name,
      uri: `agent://${name}`,
      status: "running",
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
