/**
 * Gateway Router — routes messages between agents.
 *
 * `agent://name` is the ONLY scheme. The router is stateless (no message
 * persistence); each provider owns its own conversation history.
 *
 * A `null` return means the message was ACCEPTED BY THE DESTINATION, not merely
 * addressed to one. Anything else is a string saying why it has not arrived.
 * That distinction is the whole point of this module: `routeMessage` used to
 * return `null` the moment it found a plausible recipient, so a sender was told
 * "sent" for a message injected into a dead daemon, a threadless agent, or a
 * Slack stub that only ever wrote to the console. See ADR-064.
 *
 * "Accepted by the destination" is as far as this goes, per provider:
 *   - Claude Code — the write landed on an OPEN, registered, token-verified
 *     channel-server socket. NOT a confirmation that the agent read or can
 *     answer it; there is no application-level receipt from the far side.
 *   - Codex — the agent's app-server daemon replied to `turn/start`.
 */

import type {
  AgentInfo,
  GatewayMessage,
  GatewayWsMessage,
} from "@autonomos/core";
import type { WSContext, WSReadyState } from "hono/ws";
import { noteChannelServerRegistered } from "../agents/channelServerCheck.js";
import { getAgentSidecarEndpoint } from "../agents/runtime.js";
import { getAgent, listAgents, resolveAgentByName } from "../agents/store.js";
import { batchGetTitles } from "../titleCache.js";
import {
  type CodexDeliveryResult,
  deliverToCodex,
  formatInbound,
} from "./codexControl.js";
import { DELIVERY_ACK_MS } from "./deliveryTimings.js";

// ── Registry ──────────────────────────────────────────────────────

/** Connected channel MCP server WebSockets, keyed by autonomOS agent id. */
const sessionClients = new Map<string, WSContext>();

/** `WSContext.readyState` for OPEN. Hono types this as a numeric union rather
 *  than exporting the constants, so name it once here — annotated so the
 *  compiler checks the value against that union instead of trusting this
 *  comment (a bare `= 4` would otherwise sail through). */
const WS_OPEN: WSReadyState = 1;

/**
 * How long a `send()` may wait for a delivery to be CONFIRMED before it reports
 * the message as not-yet-arrived.
 *
 * Needed because `deliverToCodex` settles only on a terminal outcome: a message
 * buffered behind a transport failure never settles at all, and an unbounded
 * await would hang the sender's tool call for as long as the daemon stays sick.
 *
 * Must stay comfortably under the channel server's `send_result` deadline —
 * see `deliveryTimings.ts`, which holds both numbers and whose companion test
 * enforces the ordering that used to live only in two prose comments.
 *
 * MEASURED against a loopback daemon (12 sends): the first costs 14.8ms — it
 * pays connect + initialize + thread discovery — and steady-state sends run a
 * 0.2ms median, 0.3ms max. So this window is ~135x the cold path, and it only
 * elapses when the transport is genuinely sick, which is exactly when "not
 * delivered" is the true answer. The number that could move it is a real
 * daemon's own responsiveness under load, not our overhead.
 */
const DEFAULT_DELIVERY_ACK_MS = DELIVERY_ACK_MS;
let deliveryAckMs = DEFAULT_DELIVERY_ACK_MS;

/** For tests — shrink the ack window so the not-yet-delivered path is reachable
 *  in ms. Called with no argument to restore the production value. */
export function _setDeliveryAckWindowForTesting(ms?: number): void {
  deliveryAckMs = ms ?? DEFAULT_DELIVERY_ACK_MS;
}

// ── Public API ────────────────────────────────────────────────────

export function registerSessionClient(sessionId: string, ws: WSContext): void {
  sessionClients.set(sessionId, ws);
  console.log(`[gateway] agent ${sessionId} connected`);
  // Registration edge: stands down any pending post-spawn probe for this agent
  // and retracts a premature "can't send messages" warning (the probes gave up
  // but the channel server showed up after all).
  noteChannelServerRegistered(sessionId);
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

/** Has this agent's channel-server MCP subprocess connected + registered? A
 *  positive signal that the agent's OUTBOUND path (send + org tools) is live.
 *  The runtime probes this after spawn to detect a Codex agent whose daemon-
 *  launched channel server never came up (a silent loss of send()). */
export function isSessionClientRegistered(sessionId: string): boolean {
  return sessionClients.has(sessionId);
}

// ── URI-based message routing ─────────────────────────────────────

/**
 * Route a message by URI.
 *
 * Returns `null` only if the destination ACCEPTED the message; otherwise a
 * string explaining why it has not arrived — suitable for showing the sender
 * verbatim.
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

  if (scheme === "agent") return routeToAgent(fromSessionId, path, message);

  // `broadcast://all` was removed (ADR-064), but every agent spawned before
  // that ships still carries it in the tool list baked into its system prompt —
  // that text is fixed at spawn and cannot be revised for a live agent. A bare
  // "unknown scheme" would read as a bug in the URI rather than a removal, so
  // name it and point at the replacement.
  if (scheme === "broadcast") {
    return (
      'broadcast:// was removed. Send to each agent individually with "agent://<name>" — ' +
      "use list_agents to enumerate them."
    );
  }

  return `Unknown URI scheme: "${scheme}" — supported: agent`;
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

/** Display names for system (non-agent) senders. These arrive as literal
 *  sender ids, not UUIDs, so without this map they hit the unknown-id branch
 *  below and render as a sliced pseudo-UUID ("Agent schedule"). */
const SYSTEM_SENDER_NAMES: Record<string, string> = {
  scheduler: "Scheduler",
};

/** Resolve the display name for an agent id (enriched via titleCache) */
async function resolveAgentName(agentId: string): Promise<string> {
  const systemName = SYSTEM_SENDER_NAMES[agentId];
  if (systemName) return systemName;
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
    chatId: "",
    userId: senderId,
    userName: senderName,
    text,
    fromUri: `agent://${senderName}`,
    timestamp: Date.now(),
  };
}

/** What the sender is told when the ack window expires. Deliberately NOT a
 *  terminal outcome — the message is still queued and still being retried,
 *  which is why the wording forbids a re-send rather than reporting a failure.
 *  Kept next to the window that produces it. */
const NOT_YET_DELIVERED: CodexDeliveryResult = {
  delivered: false,
  reason:
    "it has not reached the agent's Codex daemon yet — it stays queued " +
    "and is retried automatically, so do NOT re-send it",
};

/**
 * Wait for a Codex delivery to reach a terminal outcome, but never longer than
 * the ack window.
 *
 * A buffered message settles at no terminal state by design, so the expiry is
 * not an error case — it is the honest answer for "we tried, it has not landed,
 * it is still being retried". The wording matters: the sender must not re-send,
 * because a duplicate makes a Codex agent execute the same instruction twice.
 *
 * `unref()` and `clearTimeout` do different jobs and both are needed: the first
 * stops a pending window holding the process open, the second stops a 2s timer
 * outliving a 0.2ms delivery.
 */
async function awaitDelivery(
  pending: Promise<CodexDeliveryResult>,
): Promise<CodexDeliveryResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<CodexDeliveryResult>((resolve) => {
    timer = setTimeout(resolve, deliveryAckMs, NOT_YET_DELIVERED);
    timer.unref?.();
  });
  try {
    return await Promise.race([pending, expired]);
  } finally {
    clearTimeout(timer);
  }
}

async function routeToAgent(
  fromSessionId: string,
  targetName: string,
  content: string,
): Promise<string | null> {
  // Codex agents receive inbound via their app-server daemon (turn/start), not
  // the channel-server WS — that path only Claude Code's channels feature
  // consumes. Resolve the record directly (a Codex agent need not have a
  // channel-server connection to receive messages).
  const codexTarget = resolveRunningCodexAgent(targetName);
  if (codexTarget) {
    if (codexTarget.id === fromSessionId) return "Cannot send to yourself.";
    const endpoint = getAgentSidecarEndpoint(codexTarget.id);
    if (!endpoint) {
      return `Codex agent "${targetName}" is not reachable — its app-server daemon isn't running.`;
    }
    const senderName = await resolveAgentName(fromSessionId);
    const delivery = await awaitDelivery(
      deliverToCodex(
        codexTarget.id,
        endpoint,
        formatInbound(senderName, `agent://${senderName}`, content),
      ),
    );
    if (!delivery.delivered) {
      return `Message to Codex agent "${targetName}" was NOT delivered — ${delivery.reason}.`;
    }
    return null;
  }

  const resolved = await resolveConnectedAgent(targetName);
  if (!resolved) {
    console.log(`[gateway] agent "${targetName}" not found or not connected`);
    return `Agent "${targetName}" not found or not connected. Use list_agents to see available agents.`;
  }
  const [targetSessionId, target] = resolved;

  if (targetSessionId === fromSessionId) {
    return "Cannot send to yourself.";
  }

  // A Codex agent that failed the running-check above falls through to here,
  // and it DOES hold a channel-server WS (it needs one for outbound send()) —
  // so this path would "succeed" into a socket whose reader ignores inbound
  // (Codex consumes turns from its daemon, never channel notifications). That
  // happens in the seconds between markExited and the MCP subprocess dropping
  // its socket, and across a resume-crash respawn. Fail loudly instead.
  if (getAgent(targetSessionId)?.provider === "codex") {
    console.warn(
      `[gateway] Codex agent "${targetName}" is not running — inbound not delivered`,
    );
    return `Codex agent "${targetName}" is not currently running — message not delivered.`;
  }

  // A socket can be registered and already CLOSING — the registry is cleaned up
  // on the close event, which lands after the socket stops carrying data.
  // `WSContext.send()` does not reliably throw in that window (the underlying
  // impl may just drop the frame), so "no exception" was never sufficient
  // evidence of delivery. Check the state rather than infer it from silence.
  if (target.readyState !== WS_OPEN) {
    console.warn(
      `[gateway] agent "${targetName}" socket is not open (readyState=${target.readyState}) — not delivered`,
    );
    return `Agent "${targetName}" is disconnecting — message not delivered.`;
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
  return null;
}

/** Resolve a RUNNING Codex agent by id-or-name (for daemon-based inbound). */
function resolveRunningCodexAgent(idOrName: string): { id: string } | null {
  const byId = getAgent(idOrName);
  if (byId?.provider === "codex" && byId.status === "running") return byId;
  const byName = resolveAgentByName(idOrName);
  if (byName?.provider === "codex" && byName.status === "running")
    return byName;
  return null;
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
      permissionMode: a.permissionMode,
    };
  });
}
