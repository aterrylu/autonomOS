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
  Agent,
  AgentInfo,
  GatewayMessage,
  GatewayWsMessage,
} from "@autonomos/core";
import { HANDOFF_QUEUE_CAP } from "@autonomos/core";
import type { WSContext, WSReadyState } from "hono/ws";
import { noteChannelServerRegistered } from "../agents/channelServerCheck.js";
import { getAgentSidecarEndpoint } from "../agents/runtime.js";
import { getAgent, listAgents, resolveAgentByName } from "../agents/store.js";
import { emitPendingHandoffCount } from "../handoffDelivery.js";
import { enqueueHandoff } from "../handoffQueue.js";
import { getProvider } from "../providers/index.js";
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
 * Optional out-channel for metadata that rides ALONGSIDE an accept, without
 * disturbing routeMessage's `string | null` contract (ADR-064: `null` =
 * accepted, a string = NOT delivered). Today its only field is `note` — a
 * sender-facing string set by the manual-queue hand-off path ("accepted —
 * queued for hand-delivery", honest per ADR-064). A caller that doesn't care
 * (the scheduler, every existing test) simply omits it and sees the unchanged
 * `string | null`; the gateway route passes one in and renders `note` on the
 * success it sends back to the sender.
 */
export interface RouteMeta {
  note?: string;
}

/**
 * Route a message by URI.
 *
 * Returns `null` only if the destination ACCEPTED the message; otherwise a
 * string explaining why it has not arrived — suitable for showing the sender
 * verbatim. Pass `meta` to also receive an optional sender-facing `note` that
 * accompanies an accept (manual-queue hand-off).
 */
export async function routeMessage(
  to: string,
  message: string,
  fromSessionId: string,
  meta?: RouteMeta,
): Promise<string | null> {
  const sepIndex = to.indexOf("://");
  if (sepIndex === -1) {
    return `Invalid URI: "${to}" — expected scheme://path (e.g. agent://name)`;
  }

  const scheme = to.slice(0, sepIndex);
  const path = to.slice(sepIndex + 3);

  if (scheme === "agent")
    return routeToAgent(fromSessionId, path, message, meta);

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

  // schedule://<name> is a SENDER-only namespace: it identifies the scheduled
  // task that fired a prompt (its from_uri), and from_uri is exactly what
  // BASE_CONTEXT teaches agents to reply to — so answering it here with a
  // helpful pointer, not "unknown scheme", is the whole design. Actionable on
  // purpose: the reply names the schedule tools with the name pre-filled.
  if (scheme === "schedule") {
    return (
      `schedule://${path} identifies the scheduled task "${path}" that sent you a prompt — ` +
      "schedules cannot receive replies. Just do the task it delivered; the operator sees " +
      `your work in your own session. To inspect or change the schedule itself, use the MCP ` +
      `tools: get_schedule("${path}"), update_schedule, or delete_schedule.`
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
 *  below and render as a sliced pseudo-UUID ("Agent schedule").
 *
 *  "scheduler" is legacy: the scheduler now sends per-schedule ids
 *  (`schedule:<name>` → schedule://<name>, see resolveSenderIdentity), but the
 *  literal is kept so anything still passing it renders sanely. */
const SYSTEM_SENDER_NAMES: Record<string, string> = {
  scheduler: "Scheduler",
};

/** Sender ids of the form `schedule:<name>` identify the SCHEDULE that fired
 *  a prompt, not an agent. Mirrors the `agent:<name>` convention schedule
 *  TARGETS already use. */
const SCHEDULE_SENDER_PREFIX = "schedule:";

/** A resolved sender: display name + the reply URI stamped on the message.
 *  For agents the URI is agent://<name>; for schedule senders it is
 *  schedule://<name> — a different NAMESPACE, so a real agent that happens to
 *  share a schedule's name can never collide with it (the reservation concern
 *  from #330 dissolves instead of needing enforcement). */
interface SenderIdentity {
  name: string;
  uri: string;
}

async function resolveSenderIdentity(
  fromSessionId: string,
): Promise<SenderIdentity> {
  if (fromSessionId.startsWith(SCHEDULE_SENDER_PREFIX)) {
    const scheduleName = fromSessionId.slice(SCHEDULE_SENDER_PREFIX.length);
    return {
      name: `Schedule ${scheduleName}`,
      uri: `schedule://${scheduleName}`,
    };
  }
  const name = await resolveAgentName(fromSessionId);
  return { name, uri: `agent://${name}` };
}

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
  sender: SenderIdentity,
  text: string,
): GatewayMessage {
  return {
    id: crypto.randomUUID(),
    chatId: "",
    userId: senderId,
    userName: sender.name,
    text,
    fromUri: sender.uri,
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
  meta?: RouteMeta,
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
    const sender = await resolveSenderIdentity(fromSessionId);
    const delivery = await awaitDelivery(
      deliverToCodex(
        codexTarget.id,
        endpoint,
        formatInbound(sender.name, sender.uri, content),
      ),
    );
    if (!delivery.delivered) {
      return `Message to Codex agent "${targetName}" was NOT delivered — ${delivery.reason}.`;
    }
    return null;
  }

  // Manual-queue path: an inbound-less provider (Gemini) can't receive a live
  // message, so instead of failing we QUEUE it for human hand-delivery. Resolved
  // by NAME from the store — a manual-queue agent need not (and, per "Gemini
  // launches its MCP only on a turn", often does NOT) hold a channel-server
  // socket, so this MUST run before resolveConnectedAgent, which requires one.
  // The sender is told SUCCESS-with-a-note (accepted, queued) — honest per
  // ADR-064; a full queue is a real failure instead.
  const queueTarget = resolveManualQueueAgent(targetName);
  if (queueTarget) {
    if (queueTarget.id === fromSessionId) return "Cannot send to yourself.";
    const sender = await resolveSenderIdentity(fromSessionId);
    const enq = enqueueHandoff(queueTarget.id, {
      from: sender.name,
      // Store the reply address so the injected message carries the standard
      // inbound envelope ([from → you via <uri>] …) — same contract as a live
      // inbound, so the recipient treats it as mail and can reply via MCP.
      fromUri: sender.uri,
      message: content,
    });
    if (!enq.ok) {
      return (
        `Queue full — ${HANDOFF_QUEUE_CAP} undelivered messages are already ` +
        `awaiting manual delivery to "${targetName}". Not queued; try again ` +
        "once a human has delivered some."
      );
    }
    emitPendingHandoffCount(queueTarget.id, enq.count);
    // Accepted (null, per ADR-064) — the note rides the out-param so the
    // sender is told it was QUEUED, not delivered live.
    if (meta) {
      meta.note =
        `Accepted — queued for hand-delivery to "${targetName}" ` +
        `(${enq.count} pending). This agent's runtime (${queueTarget.provider}) ` +
        "has no live inbound; a human will deliver it.";
    }
    return null;
  }

  const resolved = await resolveConnectedAgent(targetName);
  if (!resolved) {
    // Replying to a SYSTEM sender is a predictable mistake: a scheduled
    // prompt's from_uri reads agent://Scheduler, which looks addressable.
    // Name what it actually is instead of returning the generic not-found,
    // which sends the agent hunting through list_agents for a peer that has
    // never existed. Checked only AFTER real resolution fails, so an actual
    // agent named "Scheduler" (discouraged) still receives its messages.
    const systemName = Object.values(SYSTEM_SENDER_NAMES).find(
      (n) => n.toLowerCase() === targetName.toLowerCase(),
    );
    if (systemName) {
      return (
        `"${systemName}" is not an agent — it is the autonomOS cron scheduler, a system sender. ` +
        "Scheduled prompts need no reply: just do the task they describe; the operator sees your work in your own session."
      );
    }
    console.log(`[gateway] agent "${targetName}" not found or not connected`);
    return `Agent "${targetName}" not found or not connected. Use list_agents to see available agents.`;
  }
  const [targetSessionId, target] = resolved;

  if (targetSessionId === fromSessionId) {
    return "Cannot send to yourself.";
  }

  const targetRec = getAgent(targetSessionId);

  // A Codex agent that failed the running-check above falls through to here,
  // and it DOES hold a channel-server WS (it needs one for outbound send()) —
  // so this path would "succeed" into a socket whose reader ignores inbound
  // (Codex consumes turns from its daemon, never channel notifications). That
  // happens in the seconds between markExited and the MCP subprocess dropping
  // its socket, and across a resume-crash respawn. Fail loudly instead. This is
  // a running-STATE race (Codex IS inbound-capable), so it stays a provider
  // check — NOT the capability guard below.
  if (targetRec?.provider === "codex") {
    console.warn(
      `[gateway] Codex agent "${targetName}" is not running — inbound not delivered`,
    );
    return `Codex agent "${targetName}" is not currently running — message not delivered.`;
  }

  // Capability guard: a runtime whose messaging.inbound is false (Gemini today)
  // holds a channel-server socket ONLY for outbound send() — its reader discards
  // channel notifications, so delivering here false-acks: the sender is told
  // "delivered" while the message silently vanishes (the ADR-064 bug class,
  // still live for Gemini). Keyed on the provider CAPABILITY (the SSOT in
  // providers/*), not a hardcoded name, so it auto-covers any future
  // inbound-less runtime instead of re-arming this exact bug for the next one.
  // Distinct from the Codex guard above: that is a running-STATE race (Codex is
  // inbound-capable); this is a PERMANENT capability, so it is unconditional.
  // Replace with real delivery once Gemini inbound lands.
  // Residual (pre-existing, shared with the Codex guard): if a target is resolved
  // by raw id whose store record was already purged, targetRec is undefined and
  // both guards are skipped, so it could still false-ack. Narrow — only the by-id
  // resolver bypasses the store — and out of scope here; noted, not fixed.
  if (
    targetRec &&
    !getProvider(targetRec.provider).capabilities.messaging.inbound
  ) {
    console.warn(
      `[gateway] agent "${targetName}" (${targetRec.provider}) has no inbound path — not delivered`,
    );
    return `Agent "${targetName}" cannot receive messages — its runtime (${targetRec.provider}) has no inbound delivery path. Not delivered.`;
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

  const sender = await resolveSenderIdentity(fromSessionId);
  const wsMsg: GatewayWsMessage = {
    type: "message",
    payload: buildAgentMessage(fromSessionId, sender, content),
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

/**
 * Resolve a RUNNING agent (by id or name) whose provider uses "manual-queue"
 * inbound — i.e. one we should queue a hand-off for rather than deliver live.
 * Requires `running`: queuing for a dead agent is pointless (there'll be no PTY
 * to inject into), mirroring the Codex resolver's running gate.
 */
function resolveManualQueueAgent(idOrName: string): Agent | null {
  const isManualQueue = (a: Agent | undefined): a is Agent =>
    !!a &&
    a.status === "running" &&
    getProvider(a.provider).capabilities.messaging.inboundMethod ===
      "manual-queue";
  const byId = getAgent(idOrName);
  if (isManualQueue(byId)) return byId;
  const byName = resolveAgentByName(idOrName);
  if (isManualQueue(byName)) return byName;
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
