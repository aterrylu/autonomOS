/**
 * Agent template types — blueprints for spawning agents.
 *
 * Templates live at ~/.autonomos/templates/{name}.json and define
 * reusable agent configurations (role, system prompt, capabilities).
 * They are the recipe; an Agent (see ./agent.ts) is the instance.
 */

import type { PermissionMode } from "./permissions";

/** Blueprint for creating agents — lives at ~/.autonomos/templates/{name}.json */
export interface AgentTemplate {
  /** Human-readable role name (e.g. "Team Lead", "Worker") */
  role: string;
  /** Short description of what this template is for */
  description: string;
  /** System prompt injected into the agent's CC session */
  systemPrompt: string;
  /** Which autonomOS capabilities the agent has access to */
  capabilities: AgentCapability[];
  /** How much autonomy agents spawned from this template have over tool use.
   *  Replaces the old `autonomousMode?: boolean`. Default: DEFAULT_PERMISSION_MODE. */
  permissionMode?: PermissionMode;
  /** Model override for litellm routing (e.g. "opus", "haiku"). Omit for CC default */
  model?: string;
}

/** Capabilities that can be granted to an agent */
export type AgentCapability =
  | "send"
  | "list_agents"
  | "create_agent"
  | "kill_agent"
  | "self_exit";
