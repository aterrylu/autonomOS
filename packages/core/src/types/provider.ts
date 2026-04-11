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
  /** Display name for the session */
  name?: string;
  /** Claude Code session ID to resume (passed as --resume <id>) */
  resumeSessionId?: string;
  /** Claude session ID to fork from — child inherits parent's conversation context */
  forkFrom?: string;
  /** Skip permission prompts (--dangerously-skip-permissions) */
  autonomousMode?: boolean;
  /** Replace the default system prompt entirely (--system-prompt) */
  systemPrompt?: string;
  /** Append to the default system prompt (--append-system-prompt) — keeps CLAUDE.md and CC defaults */
  appendSystemPrompt?: string;
  cols?: number;
  rows?: number;
  /** Template used to spawn this agent (e.g. "team-lead") */
  template?: string;
  /** Manager agent name for org chart (e.g. "CEO@company") */
  manager?: string;
  /** Project scope (e.g. "autonomOS") */
  project?: string;
}
