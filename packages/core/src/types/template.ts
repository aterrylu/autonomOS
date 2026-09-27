/**
 * Agent template types — blueprints for spawning agents.
 *
 * Templates live at ~/.autonomos/templates/{name}.json and define
 * reusable agent configurations (role, system prompt, permission mode).
 * They are the recipe; an Agent (see ./agent.ts) is the instance.
 */

import type { Provider } from "./agent";
import type { PermissionMode } from "./permissions";

/** Blueprint for creating agents — lives at ~/.autonomos/templates/{name}.json */
export interface AgentTemplate {
  /** Human-readable role name (e.g. "Team Lead", "Worker") */
  role: string;
  /** Short description of what this template is for */
  description: string;
  /** System prompt injected into the agent's CC session */
  systemPrompt: string;
  /** How much autonomy agents spawned from this template have over tool use.
   *  Replaces the old `autonomousMode?: boolean`. Default: DEFAULT_PERMISSION_MODE. */
  permissionMode?: PermissionMode;
  /**
   * Per-runtime permission in each runtime's OWN canonical values (ADR-115),
   * e.g. `{ "claude-code": { "permission-mode": "acceptEdits" },
   * codex: { approval_policy: "never" } }`. Wins over `permissionMode` for a
   * runtime it names; a runtime it doesn't name uses the operator's default.
   */
  permissions?: Partial<Record<Provider, Record<string, string>>>;
  /** Model override for litellm routing (e.g. "opus", "haiku"). Omit for CC default */
  model?: string;
}
