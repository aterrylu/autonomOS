import {
  type AgentAnalytics,
  type AgentMessageStats,
  type AgentTreeNode,
  PERMISSION_MODE_INFO,
} from "@autonomos/core";
import { useCallback, useEffect, useRef, useState } from "react";
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
          // Well-formed only (a proxy or version skew must not crash the panel).
          const ok = !!s && Array.isArray(s.peers) && Array.isArray(s.recent);
          if (alive && mine === latest && ok) setStats(s);
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
  if (!stats) return <span style={{ color: tokens.muted }}>Loading…</span>;
  const none = stats.sent === 0 && stats.received === 0;
  return (
    <div data-org-communication className="flex flex-col gap-1.5">
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
    </div>
  );
}

/** "45s", "12m", "3h 12m", "2d 4h" — a duration, for time-in-state etc. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * One agent's analytics: fetched on selection, refetched (debounced) when its
 * status changes, and every 20s while open as a backstop. Stale responses from
 * a previous agent or an older request never commit.
 */
function useAgentAnalytics(
  agentId: string,
  statusKey: string,
): AgentAnalytics | null {
  const [data, setData] = useState<AgentAnalytics | null>(null);
  const latest = useRef(0);
  const load = useCallback(() => {
    const mine = ++latest.current;
    agentsApi
      .analytics(agentId)
      .then((a) => {
        // Only a well-formed payload renders — a proxy or a version-skewed
        // server answering with something else must not crash the panel.
        const ok = !!a && typeof a === "object" && !!a.support && !!a.waits;
        if (mine === latest.current) setData(ok ? a : null);
      })
      .catch(() => {
        // Informational; keep what we had.
      });
  }, [agentId]);
  useEffect(() => {
    setData(null);
    load();
    const t = setInterval(load, 20_000);
    return () => {
      clearInterval(t);
      latest.current += 1; // orphan any in-flight request
    };
  }, [load]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: statusKey is the trigger
  useEffect(() => {
    const t = setTimeout(load, 600);
    return () => clearTimeout(t);
  }, [statusKey]);
  return data;
}

/** Re-render periodically so durations ("for 12m") stay current. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

function Section({
  title,
  tokens,
  defaultOpen = true,
  children,
  id,
}: {
  title: string;
  tokens: OrgChartTokens;
  defaultOpen?: boolean;
  children: React.ReactNode;
  id: string;
}) {
  return (
    <details
      data-org-section={id}
      open={defaultOpen}
      className="group"
      style={{ borderTop: `1px solid ${tokens.cardBorder}` }}
    >
      <summary
        className="flex cursor-pointer list-none items-center gap-1.5 py-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] focus-visible:outline-2 [&::-webkit-details-marker]:hidden"
        style={{ color: tokens.muted, outlineColor: tokens.status.active }}
      >
        <span
          aria-hidden="true"
          className="inline-block transition-transform group-open:rotate-90"
        >
          ▸
        </span>
        {title}
      </summary>
      <div className="flex flex-col gap-2 pb-3">{children}</div>
    </details>
  );
}

function Rows({
  rows,
  tokens,
}: {
  rows: Array<[string, React.ReactNode]>;
  tokens: OrgChartTokens;
}) {
  return (
    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt style={{ color: tokens.muted }}>{k}</dt>
          <dd className="m-0 min-w-0 tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const WORKING_STATUSES = new Set([
  "working",
  "tool_running",
  "orchestrating",
  "compacting",
]);

/** Color for a status segment on the 24h strip. */
function segmentColor(status: string, tokens: OrgChartTokens): string {
  if (status === "needs_input") return tokens.status.needsInput;
  if (status === "error") return tokens.status.error;
  if (WORKING_STATUSES.has(status)) return tokens.status.active;
  if (status === "idle" || status === "ready")
    return `${tokens.status.ready}80`;
  return tokens.cardBorder; // stopped / unknown
}

function ActivityStrip({
  a,
  now,
  tokens,
}: {
  a: AgentAnalytics;
  now: number;
  tokens: OrgChartTokens;
}) {
  const start = now - 86_400_000;
  const span = now - start;
  return (
    <div
      data-org-activity
      role="img"
      aria-label={`Activity over the last 24 hours: ${a.activity.length} status changes`}
      className="relative h-3.5 overflow-hidden rounded-sm"
      style={{
        border: `1px solid ${tokens.cardBorder}`,
        background: tokens.chip,
      }}
    >
      {a.activity.map((seg) => (
        <span
          key={`${seg.from}-${seg.status}`}
          data-org-segment={seg.status}
          className="absolute top-0 bottom-0"
          title={`${seg.status} · ${formatDuration(seg.to - seg.from)}`}
          style={{
            left: `${((Math.max(seg.from, start) - start) / span) * 100}%`,
            width: `${(Math.max(0, seg.to - Math.max(seg.from, start)) / span) * 100}%`,
            background: segmentColor(seg.status, tokens),
          }}
        />
      ))}
    </div>
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

  const now = useNow(15_000);
  const a = useAgentAnalytics(
    node.id,
    `${status}|${s?.lastActivityAt ?? ""}|${node.status}`,
  );
  const runtimeName =
    PROVIDER_NAMES[node.provider ?? ""] ?? node.provider ?? "this runtime";
  const na = (
    <span className="italic" style={{ color: tokens.muted }}>
      n/a for {runtimeName}
    </span>
  );

  const statusRows: Array<[string, React.ReactNode]> = [];
  if (a?.status && !exited)
    statusRows.push([
      "In state",
      <span key="st">
        <span style={{ color: labelStyle.color }}>{label}</span> for{" "}
        {formatDuration(now - a.status.since)}
      </span>,
    ]);
  if (!exited && a?.startedAt)
    statusRows.push(["Up", formatDuration(now - a.startedAt)]);
  statusRows.push([
    "Last active",
    <span
      key="la"
      style={recencyTimestampStyle(
        lastActive,
        now,
        page.statusFg,
        page.fg,
        page.bg,
      )}
    >
      {formatAge(lastActive)}
    </span>,
  ]);
  if (unread > 0)
    statusRows.push([
      "Unread",
      <span key="u" style={{ color: tokens.unread }}>
        {unread}
      </span>,
    ]);
  if (a) {
    statusRows.push([
      "Waited on you",
      a.support.needsInput ? (
        <span key="w">
          {a.waits.count}× · {formatDuration(a.waits.totalMs)}
          {a.waits.waitingSince !== null && (
            <span style={{ color: tokens.status.needsInput }}>
              {" "}
              · waiting now
            </span>
          )}
        </span>
      ) : (
        na
      ),
    ]);
    statusRows.push(["Restarts", a.restarts]);
    statusRows.push([
      "Crashes",
      a.crashes > 0 && a.lastExitCode !== null
        ? `${a.crashes} · last exit code ${a.lastExitCode}`
        : a.crashes,
    ]);
  }
  if (exited && exitReason) statusRows.push(["Exit", exitReason]);

  const detailRows: Array<[string, React.ReactNode]> = [
    ["Runtime", runtimeName],
  ];
  if (mode)
    detailRows.push(["Permissions", PERMISSION_MODE_INFO[mode]?.label ?? mode]);
  if (s?.envPreset) detailRows.push(["Model preset", s.envPreset]);
  // The tree node and the session record carry the same fields; prefer the
  // tree's, fall back to the record's (either can arrive first).
  const template = node.template ?? s?.template;
  if (template) detailRows.push(["Template", template]);
  if (node.project) detailRows.push(["Project", node.project]);
  if (cwd)
    detailRows.push([
      "Directory",
      <span key="cwd" title={cwd} className="block truncate">
        {cwd.split("/").filter(Boolean).pop() ?? cwd}
      </span>,
    ]);
  if (a?.branch) detailRows.push(["Branch", a.branch]);
  if (s?.createdAt)
    detailRows.push(["Created", `${formatAge(s.createdAt)} ago`]);
  const sessionId = s?.providerSessionId;
  if (sessionId)
    detailRows.push([
      "Session",
      <span key="sid" className="flex min-w-0 items-center gap-1.5">
        <span className="truncate font-mono text-[11px]" title={sessionId}>
          {sessionId}
        </span>
        <button
          type="button"
          className="flex-none cursor-pointer rounded px-1.5 text-[10.5px]"
          style={{ border: `1px solid ${tokens.cardBorder}` }}
          onClick={() => {
            navigator.clipboard?.writeText(sessionId).catch(() => {});
          }}
        >
          Copy
        </button>
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
      <Section id="status" title="Status" tokens={tokens}>
        <Rows rows={statusRows} tokens={tokens} />
      </Section>

      <Section id="activity" title="Activity · 24h" tokens={tokens}>
        {a ? (
          <>
            <ActivityStrip a={a} now={now} tokens={tokens} />
            <Rows
              tokens={tokens}
              rows={[
                ["Turns", a.turns],
                ["Tool calls", a.support.tools ? a.toolCalls : na],
                ["Failed tools", a.support.failedTools ? a.failedTools : na],
                [
                  "Last tool",
                  a.support.tools
                    ? a.lastTool
                      ? `${a.lastTool.name} · ${formatAge(a.lastTool.at)}`
                      : "None yet"
                    : na,
                ],
              ]}
            />
            {a.support.tools && a.tools.length > 0 && (
              <div data-org-top-tools className="flex flex-col gap-1">
                {a.tools.map((t) => (
                  <div
                    key={t.name}
                    className="grid grid-cols-[76px_1fr_28px] items-center gap-1.5 text-[11px]"
                  >
                    <span className="truncate" title={t.name}>
                      {t.name}
                    </span>
                    <span
                      className="h-1.5 rounded-sm"
                      style={{
                        width: `${(t.count / a.tools[0].count) * 100}%`,
                        background: tokens.status.active,
                      }}
                    />
                    <span className="text-right tabular-nums">{t.count}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <span style={{ color: tokens.muted }}>Loading…</span>
        )}
      </Section>

      <Section id="communication" title="Communication" tokens={tokens}>
        <CommunicationSection
          agentId={node.id}
          tokens={tokens}
          onSelect={onSelect}
        />
      </Section>

      <Section id="team" title="Team" tokens={tokens}>
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
      </Section>

      <Section id="details" title="Details" tokens={tokens} defaultOpen={false}>
        <Rows rows={detailRows} tokens={tokens} />
      </Section>

      {a && (
        <p className="m-0 text-[10.5px]" style={{ color: tokens.muted }}>
          Counts since the server started{" "}
          {new Date(a.since).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
          .
        </p>
      )}
    </aside>
  );
}
