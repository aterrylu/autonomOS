import type { Session } from "./session";

/**
 * AgentProvider interface — abstraction over agent backends.
 * Claude Code is the first implementation. Others (Gemini CLI, OpenCode)
 * can be added by implementing this interface.
 */
export interface AgentProvider {
  readonly name: string;

  /** Spawn a new agent session, returning the session metadata */
  spawn(options: SpawnOptions): Promise<Session>;

  /** Send input (keystrokes) to a running session's PTY */
  write(sessionId: string, data: string): void;

  /** Resize the PTY */
  resize(sessionId: string, cols: number, rows: number): void;

  /** Kill a running session */
  kill(sessionId: string): Promise<void>;
}

export interface SpawnOptions {
  workingDirectory: string;
  prompt?: string;
  /** Claude Code session ID to resume (passed as --resume <id>) */
  resumeSessionId?: string;
  cols?: number;
  rows?: number;
}
