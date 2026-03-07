export type SessionStatus = "starting" | "running" | "idle" | "stopped" | "error";

export interface Session {
  id: string;
  name: string;
  status: SessionStatus;
  workingDirectory: string;
  provider: string;
  createdAt: number;
  updatedAt: number;
}
