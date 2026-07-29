/**
 * Gateway types — shared between platform adapters, gateway router,
 * and the server:autonomos MCP channel server.
 */

// ── Platform Messages ─────────────────────────────────────────────

export type Platform = "slack";

/** Normalized inbound message from any platform or agent */
export interface GatewayMessage {
  id: string;
  platform: Platform;
  platformMessageId: string;
  /** Platform-specific routing key (e.g. "workspaceId:channelId" for Slack) */
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  /** URI the receiver uses to respond (e.g. "agent://name", "slack://workspace/channel") */
  fromUri: string;
  replyTo?: string;
  threadId?: string;
  timestamp: number;
}

/** Outbound reply from a CC session back to a platform */
export interface GatewayReply {
  platform: Platform;
  chatId: string;
  text: string;
  replyTo?: string;
}

// ── Platform Adapter ──────────────────────────────────────────────

export interface PlatformAdapter {
  readonly platform: Platform;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  send(reply: GatewayReply): Promise<string>;
  onMessage(handler: (msg: GatewayMessage) => void): void;
}

// ── Agent Discovery ──────────────────────────────────────────────

export interface AgentInfo {
  sessionId: string;
  name: string;
  uri: string;
  status: string;
}

// ── Gateway WebSocket Protocol ────────────────────────────────────
// Between autonomOS server and server:autonomos MCP channel subprocess

export type GatewayWsMessage =
  // agentToken: per-agent credential (ADR-055 PR B). The gateway verifies it
  // maps to sessionId before trusting the registration; a register without a
  // valid token is rejected, closing the "assert any name" spoof.
  | { type: "register"; sessionId: string; agentToken?: string }
  | { type: "dashboard_connect" }
  | { type: "message"; payload: GatewayMessage }
  | { type: "send"; to: string; message: string; requestId: string }
  | { type: "send_result"; requestId: string; success: boolean; error?: string }
  | { type: "list_agents_request"; requestId: string }
  | { type: "list_agents_response"; requestId: string; agents: AgentInfo[] };

// ── Routing ───────────────────────────────────────────────────────

export interface ChannelRoute {
  id: string;
  platform: Platform;
  chatId: string;
  chatName?: string;
  sessionId: string;
  createdAt: number;
}
