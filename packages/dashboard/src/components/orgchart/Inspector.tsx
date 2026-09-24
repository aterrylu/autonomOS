import {
  type AgentMessageStats,
  type AgentTreeNode,
  PERMISSION_MODE_INFO,
} from "@autonomos/core";
import { useEffect, useState } from "react";
import { agentsApi } from "../../api/agents";
import { agentsSocket } from "../../api/agentsSocket";
import type { AgentMenuTarget } from "../AgentContextMenu";
import { formatAge, recencyTimestampStyle } from "../recency";
import { statusLabelStyle } from "../statusLabelStyle";
import { agentStatusLabel } from "../ui/agent-status-icon";
import { ProviderAgentIcon } from "../ui/provider-icon";
import {
  type AgentInfo,
  menuTarget,
  nodeStatus,
  type PageTheme,
} from "./shared";
import type { OrgChartTokens } from "./theme";

/**
 * The Org Chart inspector — the selected agent, docked beside the chart.
 */

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

/**
 * One agent's message stats for its inspector: fetched on demand (full text
 * lives only in the server's per-agent log, never in a broadcast), refreshed
 * — debounced — whenever a message to or from this agent is routed.
 */
function useAgentMessages(agentId: string): AgentMessageStats | null {
  const [stats, setStats] = useState<AgentMessageStats | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let latest = 0; // only the newest request may commit (no out-of-order)
    const ac = new AbortController();
    const load = () => {
      const mine = ++latest;
      agentsApi
        .messages(agentId, { signal: ac.signal, limit: 5 })
        .then((s) => {
          if (alive && mine === latest) setStats(s);
        })
        .catch(() => {
          // Keep what we had; the section is informational.
        });
    };
    setStats(null);
    load();
    const off = agentsSocket.onMessageRouted((m) => {
      if (m.to !== agentId && m.from !== agentId) return;
      clearTimeout(timer);
      timer = setTimeout(load, 300);
    });
    return () => {
      alive = false;
      clearTimeout(timer);
      ac.abort();
      off();
    };
  }, [agentId]);
  return stats;
}

function CommunicationSection({
  agentId,
  tokens,
  onSelect,
}: {
  agentId: string;
  tokens: OrgChartTokens;
  onSelect: (id: string | null) => void;
}) {
  const stats = useAgentMessages(agentId);
  const heading = (
    <h4
      className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.07em]"
      style={{ color: tokens.muted }}
    >
      Communication
    </h4>
  );
  if (!stats)
    return <section className="flex flex-col gap-1.5">{heading}</section>;
  const none = stats.sent === 0 && stats.received === 0;
  return (
    <section data-org-communication className="flex flex-col gap-1.5">
      {heading}
      {none ? (
        <span style={{ color: tokens.muted }}>
          No messages since the server started.
        </span>
      ) : (
        <>
          <span className="tabular-nums">
            Sent {stats.sent} · Received {stats.received}
          </span>
          {stats.peers.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span style={{ color: tokens.muted }}>Top peers</span>
              {stats.peers.slice(0, 3).map((p) =>
                p.id ? (
                  <button
                    key={p.id}
                    type="button"
                    className="cursor-pointer rounded-full px-2 py-px text-[11px] tabular-nums focus-visible:outline-2"
                    style={{
                      border: `1px solid ${tokens.cardBorder}`,
                      outlineColor: tokens.status.active,
                    }}
                    onClick={() => onSelect(p.id)}
                  >
                    {p.name} {p.sent}↔{p.received}
                  </button>
                ) : (
                  <span key={p.name} className="text-[11px] tabular-nums">
                    {p.name} {p.received}
                  </span>
                ),
              )}
            </div>
          )}
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {stats.recent.map((m) => {
              const outgoing = m.from === agentId;
              return (
                <li
                  key={m.id}
                  data-org-message={m.id}
                  className="rounded px-2 py-1 text-[11.5px]"
                  style={{ background: tokens.chip }}
                >
                  <span
                    className="flex gap-1.5 text-[10.5px]"
                    style={{ color: tokens.muted }}
                  >
                    <span>
                      {outgoing ? `→ ${m.toName}` : `← ${m.fromName}`}
                    </span>
                    <span className="ml-auto tabular-nums">
                      {formatAge(m.ts)}
                    </span>
                  </span>
                  {/* Sanitized, capped server-side; rendered as text. */}
                  <span className="line-clamp-3 break-words">{m.text}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

export function OrgInspector({
  node,
  managerId,
  managerName,
  info,
  unread,
  tokens,
  page,
  statusMap,
  onSelect,
  onOpen,
  onResume,
  onRestart,
  onMenu,
}: {
  node: AgentTreeNode;
  managerId?: string;
  managerName?: string;
  info?: AgentInfo;
  unread: number;
  tokens: OrgChartTokens;
  page: PageTheme;
  statusMap: Record<string, AgentInfo>;
  onSelect: (id: string | null) => void;
  onOpen: (node: AgentTreeNode) => void;
  onResume: (node: AgentTreeNode, info?: AgentInfo) => void;
  onRestart: (id: string) => void;
  onMenu: (target: AgentMenuTarget, x: number, y: number) => void;
}) {
  const exited = node.status !== "running";
  const status = nodeStatus(node, info);
  const label = exited ? "Exited" : agentStatusLabel(status, info?.currentTool);
  const labelStyle = statusLabelStyle(status, tokens.isLight);
  const s = info?.session;
  const lastActive =
    s?.lastActivityAt ??
    (exited ? s?.exitedAt : undefined) ??
    s?.createdAt ??
    0;
  const mode = node.permissionMode ?? s?.permissionMode;
  const cwd = s?.workingDirectory;
  const exitReason = s?.exitReason?.replace("_", " ");

  const rows: Array<[string, React.ReactNode]> = [
    [
      "Last active",
      <span
        key="la"
        style={recencyTimestampStyle(
          lastActive,
          Date.now(),
          page.statusFg,
          page.fg,
          page.bg,
        )}
      >
        {formatAge(lastActive)}
      </span>,
    ],
  ];
  if (unread > 0)
    rows.push([
      "Unread",
      <span key="u" style={{ color: tokens.unread }}>
        {unread}
      </span>,
    ]);
  if (s?.createdAt) rows.push(["Created", `${formatAge(s.createdAt)} ago`]);
  if (exited && exitReason) rows.push(["Exit", exitReason]);
  rows.push([
    "Runtime",
    PROVIDER_NAMES[node.provider ?? ""] ?? node.provider ?? "Unknown",
  ]);
  if (mode)
    rows.push(["Permissions", PERMISSION_MODE_INFO[mode]?.label ?? mode]);
  if (s?.envPreset) rows.push(["Model preset", s.envPreset]);
  // The tree node and the session record carry the same fields; prefer the
  // tree's, fall back to the record's (either can arrive first).
  const template = node.template ?? s?.template;
  if (template) rows.push(["Template", template]);
  if (node.project) rows.push(["Project", node.project]);
  if (cwd)
    rows.push([
      "Directory",
      <span key="cwd" title={cwd} className="block truncate">
        {cwd.split("/").filter(Boolean).pop() ?? cwd}
      </span>,
    ]);

  const chipBtn =
    "inline-flex max-w-full cursor-pointer items-center gap-1 rounded-full px-2 py-px text-[11px] focus-visible:outline-2";

  return (
    <aside
      data-org-inspector={node.id}
      aria-label={`${node.name} details`}
      className="flex w-[280px] flex-none flex-col gap-3 overflow-y-auto px-4 py-3 text-[12px]"
      style={{ borderLeft: `1px solid ${tokens.cardBorder}`, color: tokens.fg }}
    >
      <div className="flex items-center gap-2">
        <ProviderAgentIcon provider={node.provider} status={status} size={18} />
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold">
          {node.name}
        </h3>
        <button
          type="button"
          aria-label="Close details"
          className="cursor-pointer rounded px-1.5 text-[14px] leading-none focus-visible:outline-2"
          style={{ color: tokens.muted, outlineColor: tokens.status.active }}
          onClick={() => onSelect(null)}
        >
          ×
        </button>
      </div>
      <div
        data-org-inspector-status
        className={`text-[12.5px] ${
          !exited && labelStyle.shimmer
            ? tokens.isLight
              ? "status-shimmer-light"
              : "status-shimmer"
            : ""
        }`}
        style={{
          color: labelStyle.color,
          fontWeight: status === "needs_input" ? 600 : undefined,
        }}
      >
        {label}
      </div>

      {/* Actions sit right under the status, where the eye already is —
          not at the bottom of a tall pane. */}
      <div className="flex flex-wrap gap-1.5">
        {exited ? (
          <button
            type="button"
            data-org-action="resume"
            className="cursor-pointer rounded px-3 py-1 text-[12px] font-medium"
            style={{ color: page.bg, background: tokens.status.ready }}
            onClick={() => onResume(node, info)}
          >
            Resume
          </button>
        ) : (
          <>
            <button
              type="button"
              data-org-action="open"
              className="cursor-pointer rounded px-3 py-1 text-[12px] font-medium"
              style={{ color: page.bg, background: tokens.status.active }}
              onClick={() => onOpen(node)}
            >
              Open terminal
            </button>
            <button
              type="button"
              data-org-action="restart"
              className="cursor-pointer rounded px-3 py-1 text-[12px]"
              style={{ border: `1px solid ${tokens.cardBorder}` }}
              onClick={() => onRestart(node.id)}
            >
              Restart
            </button>
          </>
        )}
        <button
          type="button"
          data-org-action="more"
          aria-label={`More actions for ${node.name}`}
          className="cursor-pointer rounded px-2.5 py-1 text-[12px]"
          style={{ border: `1px solid ${tokens.cardBorder}` }}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(menuTarget(node, managerName, info), r.left, r.bottom + 4);
          }}
        >
          ⋯
        </button>
      </div>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt style={{ color: tokens.muted }}>{k}</dt>
            <dd className="m-0 min-w-0">{v}</dd>
          </div>
        ))}
      </dl>

      <CommunicationSection
        agentId={node.id}
        tokens={tokens}
        onSelect={onSelect}
      />

      <section className="flex flex-col gap-1.5">
        <h4
          className="m-0 text-[10.5px] font-semibold uppercase tracking-[0.07em]"
          style={{ color: tokens.muted }}
        >
          Team
        </h4>
        <div className="flex flex-wrap items-center gap-1.5">
          <span style={{ color: tokens.muted }}>Manager</span>
          {managerId ? (
            <button
              type="button"
              className={chipBtn}
              style={{
                border: `1px solid ${tokens.cardBorder}`,
                outlineColor: tokens.status.active,
              }}
              onClick={() => onSelect(managerId)}
            >
              {managerName}
            </button>
          ) : (
            <span>None</span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span style={{ color: tokens.muted }}>
            Reports{node.children.length ? ` (${node.children.length})` : ""}
          </span>
          {node.children.length === 0 && <span>None</span>}
          {node.children.map((c) => {
            const cs = nodeStatus(c, statusMap[c.claudeSessionId]);
            return (
              <button
                key={c.id}
                type="button"
                className={chipBtn}
                style={{
                  border: `1px solid ${tokens.cardBorder}`,
                  outlineColor: tokens.status.active,
                }}
                onClick={() => onSelect(c.id)}
              >
                <span
                  aria-hidden="true"
                  className="inline-block size-1.5 rounded-full"
                  style={{
                    background:
                      c.status !== "running"
                        ? tokens.status.neutral
                        : statusLabelStyle(cs, tokens.isLight).color,
                  }}
                />
                <span className="truncate">{c.name}</span>
              </button>
            );
          })}
        </div>
      </section>
    </aside>
  );
}
