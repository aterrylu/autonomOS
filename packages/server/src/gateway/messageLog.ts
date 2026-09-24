/**
 * Message log — what the Org Chart knows about agent-to-agent traffic.
 *
 * The router stays stateless about DELIVERY (ADR-064); this module is the one
 * place an ACCEPTED message is recorded, called at each of routeToAgent's
 * accept points (Codex turn/start reply, manual-queue enqueue, Claude Code
 * socket write). It does three things:
 *
 *  1. Broadcasts a `message.routed` delta carrying only a SANITIZED preview:
 *     ANSI escapes and markdown stripped, one line, capped at
 *     PREVIEW_MAX chars. This is the only message text that is ever pushed.
 *  2. Keeps a small per-agent ring buffer (in memory, lost on restart) of
 *     recent messages with their text capped at FULL_MAX chars — read on
 *     demand by one agent's inspector via GET /api/agents/:id/messages, never
 *     broadcast.
 *  3. Counts sent / received / per-peer traffic for the inspector.
 *
 * Nothing here can change whether a message is delivered: recording runs
 * after acceptance and swallows its own errors.
 */

import { randomUUID } from "node:crypto";
import { emitAgentDelta } from "../events/agents.js";

export const PREVIEW_MAX = 60;
export const FULL_MAX = 400;
/** Recent messages kept per agent (sent + received). */
export const RING_SIZE = 50;

export interface LoggedMessage {
  id: string;
  from: string | null;
  fromName: string;
  to: string;
  toName: string;
  /** Sanitized, capped at FULL_MAX. */
  text: string;
  ts: number;
}

export interface PeerCount {
  id: string | null;
  name: string;
  sent: number;
  received: number;
}

export interface AgentMessageStats {
  sent: number;
  received: number;
  /** Busiest first. */
  peers: PeerCount[];
  /** Newest first. */
  recent: LoggedMessage[];
}

// ANSI CSI/OSC sequences (colors, cursor moves, hyperlinks).
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Other C0 controls except tab/newline (normalized to spaces below).
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** Strip terminal escapes and markdown syntax, collapse whitespace. */
export function plainText(raw: string): string {
  return raw
    .replace(ANSI, "")
    .replace(CONTROL, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1") // [label](url) → label
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/^\s*>\s?/gm, "") // blockquotes
    .replace(/(\*\*|__|~~|`{1,3})/g, "") // emphasis/code markers
    .replace(/(^|\s)[*_](\S)/g, "$1$2") // leading single * / _
    .replace(/(\S)[*_](?=\s|$)/g, "$1") // trailing single * / _
    .replace(/\s+/g, " ")
    .trim();
}

/** Cap by code points (never split a surrogate pair), with an ellipsis. */
function cap(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max
    ? text
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

export const previewOf = (raw: string) => cap(plainText(raw), PREVIEW_MAX);
export const fullOf = (raw: string) => cap(plainText(raw), FULL_MAX);

const rings = new Map<string, LoggedMessage[]>();
const sent = new Map<string, number>();
const received = new Map<string, number>();
// peers.get(agent).get(peerKey) — peerKey is the peer's id, or `name:<n>`
// for a non-agent sender (a schedule).
const peers = new Map<string, Map<string, PeerCount>>();

function push(agentId: string, m: LoggedMessage): void {
  const ring = rings.get(agentId) ?? [];
  ring.push(m);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  rings.set(agentId, ring);
}

function bumpPeer(
  agentId: string,
  peer: { id: string | null; name: string },
  dir: "sent" | "received",
): void {
  const table = peers.get(agentId) ?? new Map<string, PeerCount>();
  const key = peer.id ?? `name:${peer.name}`;
  const row = table.get(key) ?? {
    id: peer.id,
    name: peer.name,
    sent: 0,
    received: 0,
  };
  row.name = peer.name; // a rename shows the current name
  row[dir] += 1;
  table.set(key, row);
  peers.set(agentId, table);
}

/**
 * Record an ACCEPTED message. `from` is the sender's agent id, or null for a
 * non-agent sender. Never throws — recording must not turn a delivered message
 * into an error for its sender.
 */
export function recordAcceptedMessage(input: {
  from: string | null;
  fromName: string;
  to: string;
  toName: string;
  content: string;
  now?: number;
}): void {
  try {
    const ts = input.now ?? Date.now();
    const m: LoggedMessage = {
      id: randomUUID(),
      from: input.from,
      fromName: input.fromName,
      to: input.to,
      toName: input.toName,
      text: fullOf(input.content),
      ts,
    };
    push(input.to, m);
    received.set(input.to, (received.get(input.to) ?? 0) + 1);
    bumpPeer(input.to, { id: input.from, name: input.fromName }, "received");
    if (input.from) {
      push(input.from, m);
      sent.set(input.from, (sent.get(input.from) ?? 0) + 1);
      bumpPeer(input.from, { id: input.to, name: input.toName }, "sent");
    }
    emitAgentDelta({
      type: "message.routed",
      id: m.id,
      from: input.from,
      fromName: input.fromName,
      to: input.to,
      toName: input.toName,
      preview: previewOf(input.content),
      ts,
    });
  } catch (err) {
    console.warn(
      `[messageLog] failed to record a delivered message: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/** One agent's traffic, for its inspector. */
export function getAgentMessageStats(
  agentId: string,
  limit = 20,
): AgentMessageStats {
  const ring = rings.get(agentId) ?? [];
  return {
    sent: sent.get(agentId) ?? 0,
    received: received.get(agentId) ?? 0,
    peers: [...(peers.get(agentId)?.values() ?? [])]
      .map((p) => ({ ...p }))
      .sort((a, b) => b.sent + b.received - (a.sent + a.received)),
    recent: ring.slice(-Math.max(0, limit)).reverse(),
  };
}

/** Drop an agent's log (on hard delete). */
export function forgetAgentMessages(agentId: string): void {
  rings.delete(agentId);
  sent.delete(agentId);
  received.delete(agentId);
  peers.delete(agentId);
}

/** For tests. */
export function _resetMessageLogForTesting(): void {
  rings.clear();
  sent.clear();
  received.clear();
  peers.clear();
}
