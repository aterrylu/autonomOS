import type { AgentTreeNode } from "@autonomos/core";
import type { SessionInfo, THEMES } from "../../store";
import type { AgentMenuTarget } from "../AgentContextMenu";
import type { AgentStatus } from "../ui/agent-status-icon";

/** Helpers shared by the Org Chart panel, its cards and its inspector. */

export type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

export interface AgentInfo {
  session: SessionInfo;
  agentStatus: AgentStatus;
  currentTool?: string;
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
