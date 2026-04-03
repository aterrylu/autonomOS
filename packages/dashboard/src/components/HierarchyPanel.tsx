import { useEffect, useMemo, useState } from "react";
import { Tree, TreeNode } from "react-organizational-chart";
import type { SessionInfo } from "../store";
import { THEMES, useStore } from "../store";
import { Codicon } from "./Codicon";
import {
  type AgentStatus,
  AgentStatusIcon,
  agentStatusLabel,
} from "./ui/agent-status-icon";

/**
 * Org chart tree panel — top-down hierarchy visualization.
 *
 * Uses react-organizational-chart for layout + CSS connectors.
 * Cards show agent name, template, and live status.
 */

// ── Types ────────────────────────────────────────────────────────

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

interface OrgNode {
  name: string;
  template?: string;
  project?: string;
  children: OrgNode[];
}

const WORKING_STATUSES: ReadonlySet<AgentStatus> = new Set([
  "working",
  "tool_running",
  "orchestrating",
]);

// ── Data fetching ────────────────────────────────────────────────

function useOrgChart() {
  const [chart, setChart] = useState<OrgNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function fetchChart() {
      try {
        const res = await fetch("/api/org");
        if (!res.ok) {
          if (!cancelled) setError(`Server error (${res.status})`);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          if (Array.isArray(data)) {
            setChart(data);
            setError(null);
          } else {
            setError("Unexpected response format");
          }
        }
      } catch {
        if (!cancelled) {
          setError("Cannot reach server");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchChart();
    const interval = setInterval(fetchChart, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return { chart, loading, error };
}

// ── Status resolver ──────────────────────────────────────────────

function useAgentStatusByName() {
  const sessions = useStore((s) => s.sessions);
  const agentStatuses = useStore((s) => s.agentStatuses);

  return useMemo(() => {
    const map: Record<
      string,
      { session: SessionInfo; agentStatus: AgentStatus; currentTool?: string }
    > = {};
    for (const session of sessions) {
      const statusInfo = agentStatuses[session.id];
      const agentStatus: AgentStatus =
        (statusInfo?.status as AgentStatus) ??
        (session.status === "stopped" ? "stopped" : "unknown");
      map[session.name.toLowerCase()] = {
        session,
        agentStatus,
        currentTool: statusInfo?.currentTool,
      };
    }
    return map;
  }, [sessions, agentStatuses]);
}

// ── Accent line gradient helper ──────────────────────────────────

function accentGradient(isWorking: boolean, isRunning: boolean): string {
  if (isWorking) return "linear-gradient(90deg, #3b82f6, #9333ea)";
  if (isRunning) return "linear-gradient(90deg, #22c55e, #10b981)";
  return "rgba(255,255,255,0.06)";
}

// ── Agent Card ───────────────────────────────────────────────────

interface OrgNodeProps {
  node: OrgNode;
  page: PageTheme;
  statusMap: ReturnType<typeof useAgentStatusByName>;
}

function AgentCard({ node, page, statusMap }: OrgNodeProps) {
  const info = statusMap[node.name.toLowerCase()];
  const agentStatus: AgentStatus = info?.agentStatus ?? "stopped";
  const isRunning = info != null && info.session.status !== "stopped";
  const isWorking = WORKING_STATUSES.has(agentStatus);

  return (
    <div
      className="inline-block text-left transition-all duration-300 relative group"
      style={{ minWidth: 180, maxWidth: 250 }}
    >
      {/* Glow effect for active agents */}
      {isRunning && (
        <div
          className="absolute -inset-[1px] rounded-xl opacity-60 blur-sm transition-opacity duration-500"
          style={{
            background: isWorking
              ? "linear-gradient(135deg, rgba(59,130,246,0.3), rgba(147,51,234,0.2))"
              : "linear-gradient(135deg, rgba(34,197,94,0.2), rgba(16,185,129,0.15))",
          }}
        />
      )}

      {/* Card */}
      <div
        className="relative rounded-xl px-4 py-3 backdrop-blur-sm"
        style={{
          background: isRunning
            ? "rgba(28, 36, 51, 0.9)"
            : "rgba(28, 36, 51, 0.6)",
          border: `1px solid ${isRunning ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.04)"}`,
          boxShadow: isRunning
            ? "0 4px 16px rgba(0,0,0,0.3), inset 0 1px 0 rgba(255,255,255,0.03)"
            : "0 2px 8px rgba(0,0,0,0.2)",
        }}
      >
        {/* Top accent line */}
        <div
          className="absolute top-0 left-3 right-3 h-[2px] rounded-full"
          style={{ background: accentGradient(isWorking, isRunning) }}
        />

        {/* Name row */}
        <div className="flex items-center gap-2.5 mt-1 mb-2">
          <AgentStatusIcon status={agentStatus} size={14} />
          <span
            className="text-[13px] font-semibold tracking-tight truncate"
            style={{ color: isRunning ? "#e6e1cf" : page.statusFg }}
          >
            {node.name}
          </span>
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-2">
          {node.template && (
            <span
              className="text-[10px] px-2 py-0.5 rounded-full truncate font-medium"
              style={{
                background: "rgba(255,255,255,0.06)",
                color: page.statusFg,
                letterSpacing: "0.02em",
              }}
            >
              {node.template}
            </span>
          )}
          <span
            className="text-[10px] truncate ml-auto"
            style={{
              color: isWorking ? "#93c5fd" : page.statusFg,
              fontStyle: isWorking ? "italic" : "normal",
            }}
          >
            {agentStatusLabel(agentStatus, info?.currentTool)}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Recursive tree rendering ─────────────────────────────────────

function OrgTreeNode({ node, page, statusMap }: OrgNodeProps) {
  return (
    <TreeNode
      label={<AgentCard node={node} page={page} statusMap={statusMap} />}
    >
      {node.children.map((child) => (
        <OrgTreeNode
          key={child.name}
          node={child}
          page={page}
          statusMap={statusMap}
        />
      ))}
    </TreeNode>
  );
}

// ── Content states ──────────────────────────────────────────────

function HierarchyContent({
  chart,
  loading,
  error,
  page,
  statusMap,
}: {
  chart: OrgNode[];
  loading: boolean;
  error: string | null;
  page: PageTheme;
  statusMap: ReturnType<typeof useAgentStatusByName>;
}) {
  if (loading) {
    return (
      <div
        className="flex items-center justify-center flex-1 text-sm"
        style={{ color: page.statusFg }}
      >
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="flex flex-col items-center justify-center flex-1 gap-2 text-sm"
        style={{ color: "#ea6c73" }}
      >
        <span>{error}</span>
        <span className="text-xs opacity-60" style={{ color: page.statusFg }}>
          Retrying automatically...
        </span>
      </div>
    );
  }

  if (chart.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center flex-1 gap-2 text-sm"
        style={{ color: page.statusFg }}
      >
        <span>No agents running</span>
        <span className="text-xs opacity-60">
          Spawn agents and use set_manager() to build the hierarchy
        </span>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-8">
      <div className="flex flex-col gap-12 items-center">
        {chart.map((root) => (
          <Tree
            key={root.name}
            label={<AgentCard node={root} page={page} statusMap={statusMap} />}
            lineWidth="2px"
            lineColor="rgba(255,255,255,0.15)"
            lineBorderRadius="12px"
            lineHeight="28px"
            lineStyle="solid"
            nodePadding="12px"
          >
            {root.children.map((child) => (
              <OrgTreeNode
                key={child.name}
                node={child}
                page={page}
                statusMap={statusMap}
              />
            ))}
          </Tree>
        ))}
      </div>
    </div>
  );
}

// ── Main Panel ───────────────────────────────────────────────────

export function HierarchyPanel() {
  const theme = useStore((s) => s.theme);
  const setViewMode = useStore((s) => s.setViewMode);
  const page = THEMES[theme].page;
  const statusMap = useAgentStatusByName();
  const { chart, loading, error } = useOrgChart();

  return (
    <div
      className="flex flex-col h-full w-full"
      style={{ background: page.bg }}
    >
      {/* Panel header */}
      <div
        className="flex items-center px-4 py-2 shrink-0"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <Codicon
          name="type-hierarchy"
          size={14}
          style={{ color: page.statusFg }}
        />
        <span className="text-xs font-medium ml-2" style={{ color: page.fg }}>
          Org Chart
        </span>
        <button
          type="button"
          onClick={() => setViewMode("terminal")}
          className="ml-auto cursor-pointer p-1 rounded transition-colors"
          style={{ color: page.statusFg }}
          title="Close org chart"
        >
          <Codicon name="close" size={14} />
        </button>
      </div>

      <HierarchyContent
        chart={chart}
        loading={loading}
        error={error}
        page={page}
        statusMap={statusMap}
      />
    </div>
  );
}
