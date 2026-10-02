import type { AgentTreeNode } from "@autonomos/core";
import type { SessionInfo, THEMES } from "../../store";
import type { AgentMenuTarget } from "../AgentContextMenu";
import { type AgentStatus, agentStatusLabel } from "../ui/agent-status-icon";

/** Helpers shared by the Org Chart panel, its cards and its inspector. */

export type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

export interface AgentInfo {
  session: SessionInfo;
  agentStatus: AgentStatus;
  currentTool?: string;
  /** What the tool is working on: a file's basename or a shell program's
   *  name, never a path or arguments (extracted server-side). */
  toolDetail?: string;
}

/** Shell tools, whose detail is the PROGRAM they run (Claude Code, Gemini). */
const SHELL_TOOLS = new Set(["Bash", "run_shell_command"]);

/**
 * The live action on a card and in the inspector: "Edit store.ts",
 * "Running npm". Without a detail it's the sidebar's label ("Running Edit"),
 * and a runtime that reports no tools at all (Codex) reads "Working" — the
 * chart never guesses.
 */
export function actionLabel(status: AgentStatus, info?: AgentInfo): string {
  const tool = info?.currentTool;
  const detail = info?.toolDetail;
  if (status === "tool_running" && tool && detail)
    return SHELL_TOOLS.has(tool) ? `Running ${detail}` : `${tool} ${detail}`;
  return agentStatusLabel(status, tool);
}

/** Resolve the displayed status for a tree node. */
export function nodeStatus(node: AgentTreeNode, info?: AgentInfo): AgentStatus {
  if (node.status !== "running") return "stopped";
  return info?.agentStatus ?? "unknown";
}

export function menuTarget(
  node: AgentTreeNode,
  managerName: string | undefined,
  info: AgentInfo | undefined,
): AgentMenuTarget {
  const workingDirectory = info?.session.workingDirectory;
  return node.status === "running"
    ? {
        id: node.id,
        name: node.name,
        status: "running",
        manager: managerName,
        workingDirectory,
      }
    : {
        id: node.id,
        name: node.name,
        status: "exited",
        manager: managerName,
        // An autonomOS agent resumes by its record id (the resume route
        // restores template, manager and cwd from the record).
        resumeKey: node.id,
        workingDirectory,
        isAutonomosAgent: true,
      };
}
