export type SessionStatus =
  | "starting"
  | "running"
  | "idle"
  | "stopped"
  | "error";

export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  workingDirectory: string;
  provider: string;
  /** Claude Code session ID when this was started via --resume */
  claudeSessionId?: string;
  /** Whether this session survives server reboots */
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}
