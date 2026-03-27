/**
 * Gateway types — shared between platform adapters, gateway router,
 * and the server:autonomos MCP channel server.
 */

// ── Platform Messages ─────────────────────────────────────────────

export type Platform = "discord" | "telegram" | "slack";

/** Normalized inbound message from any platform or agent */
export interface GatewayMessage {
  id: string;
  platform: Platform;
  platformMessageId: string;
  /** Platform-specific routing key (e.g. "guildId:channelId" for Discord) */
  chatId: string;
  userId: string;
  userName: string;
  text: string;
  /** URI the receiver uses to respond (e.g. "agent://name", "discord://guild/channel") */
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

// ── Gateway WebSocket Protocol ────────────────────────────────────
// Between autonomOS server and server:autonomos MCP channel subprocess

export type GatewayWsMessage =
  | { type: "register"; sessionId: string }
  | { type: "dashboard_connect" }
  | { type: "message"; payload: GatewayMessage }
  | { type: "send"; to: string; message: string }
  | { type: "send_result"; success: boolean; error?: string }
  | { type: "list_agents_request"; requestId: string }
  | {
      type: "list_agents_response";
      requestId: string;
      agents: Array<{
        sessionId: string;
        name: string;
        uri: string;
        status: string;
      }>;
    };

// ── Routing ───────────────────────────────────────────────────────

export interface ChannelRoute {
  id: string;
  platform: Platform;
  chatId: string;
  chatName?: string;
  sessionId: string;
  createdAt: number;
}
