/**
 * Gateway types — shared between platform adapters, gateway router,
 * and the server:autonomos MCP channel server.
 */

import type { PermissionMode } from "./permissions";

// ── Agent Messages ────────────────────────────────────────────────
// `Platform`, `GatewayMessage.platform`, and `platformMessageId` went with the
// last ADR-064 adapter vestiges — hardcoded `"slack"`, read by nothing.

/** An agent-to-agent message routed through the gateway. */
export interface GatewayMessage {
  id: string;
  /** Set to the sender's session id, which makes it identical to `userId` —
   *  and read by nothing. Kept only because dropping it changes the
   *  channel-server wire payload; slated for removal with the other unread
   *  fields. */
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  /** URI the receiver uses to respond — always `agent://name` since ADR-064
   *  removed the platform schemes. BASE_CONTEXT tells agents to reply to this,
   *  so a wrong or empty value strands the reply with nobody informed. */
  fromUri: string;
  replyTo?: string;
  threadId?: string;
  timestamp: number;
}

// `GatewayReply` and `PlatformAdapter` lived here until ADR-064. The whole
// framework had exactly one implementation — a StubAdapter whose send() was a
// console.log returning a fabricated message id — so `slack://` reported
// success for every message by construction. Removed with the adapters. An
// unused EXPORT is never a compile error, so nothing would have caught these.

// ── Agent Discovery ──────────────────────────────────────────────

export interface AgentInfo {
  sessionId: string;
  name: string;
  uri: string;
  status: string;
  /** How much autonomy this agent has over tool use.
   *
   *  Present so an agent can VERIFY a peer's mode rather than infer it. Without
   *  it, `list_agents` — the only fleet view a spawned agent has — reported just
   *  name/uri/status, so an agent that restarted a peer into a different mode
   *  had no way to confirm it took effect. Optional so a channel server from a
   *  NEWER build stays readable against an older server that doesn't send it. */
  permissionMode?: PermissionMode;
}

// ── Gateway WebSocket Protocol ────────────────────────────────────
// Between autonomOS server and server:autonomos MCP channel subprocess

export type GatewayWsMessage =
  // agentToken: per-agent credential (ADR-055 PR B). The gateway verifies it
  // maps to sessionId before trusting the registration; a register without a
  // valid token is rejected, closing the "assert any name" spoof.
  | { type: "register"; sessionId: string; agentToken?: string }
  // `dashboard_connect` was removed: ADR-055 put /ws/gateway on the internal
  // Unix socket, which no browser can dial. A dashboard feed needs a public
  // /ws endpoint and its own contract.
  | { type: "message"; payload: GatewayMessage }
  | { type: "send"; to: string; message: string; requestId: string }
  | {
      type: "send_result";
      requestId: string;
      success: boolean;
      error?: string;
      /** On success, an optional sender-facing note rendered ALONGSIDE the
       *  accept — used by the manual-queue hand-off path to say "accepted —
       *  queued for hand-delivery" (honest per ADR-064: accepted, not
       *  delivered). Absent for a plain live accept. */
      note?: string;
    }
  | { type: "list_agents_request"; requestId: string }
  | { type: "list_agents_response"; requestId: string; agents: AgentInfo[] };

// `ChannelRoute` (the platform→session routing table) went with the adapters in
// ADR-064. Its last reader was `setRoutes`, and the `settings.routes` field it
// typed is now scrubbed on read as a removed key.
