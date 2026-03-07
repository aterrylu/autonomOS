/**
 * Events emitted by agent sessions.
 * The server parses these from Claude Code's stream-json output
 * and forwards them to the dashboard over SSE/WebSocket.
 */

export type AgentEventType =
  | "session:start"
  | "session:end"
  | "message:assistant"
  | "message:user"
  | "tool:start"
  | "tool:end"
  | "token:usage"
  | "error";

export interface AgentEvent {
  type: AgentEventType;
  sessionId: string;
  timestamp: number;
  data: Record<string, unknown>;
}
