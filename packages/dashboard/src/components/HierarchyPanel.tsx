import type { AgentTreeNode } from "@autonomos/core";
import { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { orgTreePoll } from "../api/polls";
import { usePoll } from "../api/usePoll";
import { focusTerminal } from "../hooks/useTerminal";
import type { SessionInfo } from "../store";
import { THEMES, useStore } from "../store";
import { AgentContextMenu, type AgentMenuTarget } from "./AgentContextMenu";
import { CARD_H, CARD_W, elbowPath, layoutOrg, PAD } from "./orgchart/layout";
import { pruneExited } from "./orgchart/pruneExited";
import { type OrgChartTokens, orgChartTokens } from "./orgchart/theme";
import { formatAge, recencyTimestampStyle } from "./recency";
import { statusLabelStyle } from "./statusLabelStyle";
import {
  type AgentStatus,
  AgentStatusIcon,
  agentStatusLabel,
} from "./ui/agent-status-icon";
import { ProviderAgentIcon } from "./ui/provider-icon";

/**
 * Org chart — the manager/report hierarchy as a canvas of agent cards.
 *
 * Built from four small layers so each concern is testable on its own:
 *  - data: `orgTreePoll` (the tree WITH exited agents, push-fed like the rest)
 *  - pruneExited: which exited agents to draw (ghosts that hold a live team)
 *  - layoutOrg: tidy-tree geometry (teams side by side, solo agents on a shelf)
 *  - orgChartTokens: every color, from the theme + the sidebar status palette
 *
 * Interaction mirrors the sidebar row: click opens the agent's terminal,
 * right-click opens the SAME AgentContextMenu (ADR-093).
 */

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

// ── Data ─────────────────────────────────────────────────────────

/**
 * Read the org chart's tree (exited agents included). The three error strings
 * are derived from the typed `ApiError`: status 0 means the request never
 * reached the server, anything else is the server answering with a failure.
 */
export function useOrgChart() {
  const { data, error } = usePoll(orgTreePoll);

  const chart = Array.isArray(data) ? data : [];
  const loading = data === null && error === null;
  const message = error
    ? error.unreachable
      ? "Cannot reach server"
      : `Server error (${error.status})`
    : data !== null && !Array.isArray(data)
      ? "Unexpected response format"
      : null;

  return { chart, loading, error: message };
}

interface AgentInfo {
  session: SessionInfo;
  agentStatus: AgentStatus;
  currentTool?: string;
}

/**
 * Live activity per agent, keyed by `claudeSessionId` (the tree's key — equal to
 * the agent id). Keying by id, not name, keeps two same-named agents from
 * trading status.
 */
export function useAgentStatusById() {
  const sessions = useStore((s) => s.sessions);
  const exitedSessions = useStore((s) => s.exitedSessions);
  const agentStatuses = useStore((s) => s.agentStatuses);

  return useMemo(() => {
    const map: Record<string, AgentInfo> = {};
    const put = (
      session: SessionInfo,
      agentStatus: AgentStatus,
      currentTool?: string,
    ) => {
      if (!session.claudeSessionId) return;
      map[session.claudeSessionId] = { session, agentStatus, currentTool };
    };
    for (const session of exitedSessions) put(session, "stopped");
    for (const session of sessions) {
      const statusInfo = agentStatuses[session.id];
      const agentStatus: AgentStatus =
        (statusInfo?.status as AgentStatus) ??
        (session.status === "stopped" ? "stopped" : "unknown");
      put(session, agentStatus, statusInfo?.currentTool);
    }
    return map;
  }, [sessions, exitedSessions, agentStatuses]);
}

/** Resolve the displayed status for a tree node. */
function nodeStatus(node: AgentTreeNode, info?: AgentInfo): AgentStatus {
  if (node.status !== "running") return "stopped";
  return info?.agentStatus ?? "unknown";
}

// ── Card ─────────────────────────────────────────────────────────

interface CardProps {
  node: AgentTreeNode;
  x: number;
  y: number;
  managerName?: string;
  info?: AgentInfo;
  unread: number;
  tokens: OrgChartTokens;
  page: PageTheme;
  onOpen: (node: AgentTreeNode) => void;
  onResume: (node: AgentTreeNode, info?: AgentInfo) => void;
  onMenu: (target: AgentMenuTarget, x: number, y: number) => void;
}

function menuTarget(
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

function OrgCard({
  node,
  x,
  y,
  managerName,
  info,
  unread,
  tokens,
  page,
  onOpen,
  onResume,
  onMenu,
}: CardProps) {
  const agentIconStyle = useStore((s) => s.agentIconStyle);
  const exited = node.status !== "running";
  const status = nodeStatus(node, info);
  const label = exited ? "Exited" : agentStatusLabel(status, info?.currentTool);
  const labelStyle = statusLabelStyle(status, tokens.isLight);
  // "Working" is exactly the sidebar's shimmer set — one definition (ADR-090).
  const working = !exited && labelStyle.shimmer;
  const attention = !exited && status === "needs_input";
  const s = info?.session;
  const lastActive =
    s?.lastActivityAt ??
    (exited ? s?.exitedAt : undefined) ??
    s?.createdAt ??
    0;

  // The ring/glow colors ride CSS variables so index.css's keyframes stay
  // palette-free and follow the theme.
  const cardVars = {
    "--org-shadow": tokens.cardShadow,
    "--org-ring": attention ? tokens.attentionRing : tokens.activeRing,
    "--org-glow": attention ? tokens.attentionGlow : tokens.activeGlow,
  } as React.CSSProperties;

  // Windows/Linux fire a native `contextmenu` on the Menu key's keyup even
  // after keydown preventDefault — without this guard it would re-open the
  // menu we just opened at the card, jumping it to the browser's coordinates.
  const keyboardOpenAt = useRef(0);
  const openMenuAtCard = (el: HTMLElement) => {
    keyboardOpenAt.current = Date.now();
    const r = el.getBoundingClientRect();
    onMenu(menuTarget(node, managerName, info), r.left + 16, r.bottom - 8);
  };

  // Props both card variants share. Handlers ride the spread so the two
  // branches below can carry STATIC roles (biome checks roles statically).
  const shared = {
    tabIndex: 0,
    "data-org-card": node.id,
    "data-org-status": exited ? "exited" : status,
    "aria-label": `${node.name}, ${label}${unread > 0 ? `, ${unread} unread` : ""}${
      exited ? "" : ". Open terminal"
    }. Shift+F10 for actions.`,
    title: node.template ? `${node.name} · ${node.template}` : node.name,
    className: `org-card absolute flex flex-col justify-between rounded-[9px] px-2.5 py-2 select-none focus-visible:outline-2 focus-visible:outline-offset-2 ${
      working ? "org-card-working" : ""
    }${attention ? " org-card-attention" : ""}`,
    style: {
      ...cardVars,
      left: x,
      top: y,
      width: CARD_W,
      height: CARD_H,
      cursor: exited ? "default" : "pointer",
      // Only drawn under :focus-visible (the outline-2 utility); themed so
      // the focus mark reads as the app's, not the browser default blue.
      outlineColor: tokens.status.active,
      background: exited ? tokens.ghostCard : tokens.card,
      border: `1px ${exited ? "dashed" : "solid"} ${
        attention
          ? tokens.status.needsInput
          : status === "error"
            ? tokens.status.error
            : tokens.cardBorder
      }`,
      boxShadow: exited || working || attention ? undefined : tokens.cardShadow,
      color: tokens.fg,
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      // Enter/Space on a running card are the native <button> click — handling
      // them here too would open the agent twice.
      if (e.target !== e.currentTarget) return;
      if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault();
        openMenuAtCard(e.currentTarget);
      }
    },
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      if (Date.now() - keyboardOpenAt.current < 500) return;
      onMenu(menuTarget(node, managerName, info), e.clientX, e.clientY);
    },
  };

  const content = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <span className="flex-none" style={{ opacity: exited ? 0.6 : 1 }}>
          {agentIconStyle === "provider" ? (
            <ProviderAgentIcon
              provider={node.provider}
              status={status}
              size={16}
            />
          ) : (
            <AgentStatusIcon status={status} size={14} />
          )}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[12.5px] font-semibold tracking-tight"
          style={{ opacity: exited ? 0.6 : 1 }}
        >
          {node.name}
        </span>
        {unread > 0 && (
          <span
            className="flex-none text-[10px] font-semibold tabular-nums"
            style={{ color: tokens.unread }}
          >
            {unread} unread
          </span>
        )}
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[10.5px]">
        <span
          data-org-label
          className={`min-w-0 flex-1 truncate ${
            working
              ? tokens.isLight
                ? "status-shimmer-light"
                : "status-shimmer"
              : ""
          }`}
          style={{
            color: labelStyle.color,
            fontWeight: attention ? 600 : undefined,
          }}
        >
          {label}
        </span>
        {exited ? (
          <button
            type="button"
            className="flex-none cursor-pointer rounded px-1.5 text-[10px] leading-4"
            style={{
              color: tokens.status.ready,
              border: `1px solid ${tokens.status.ready}`,
            }}
            onClick={(e) => {
              e.stopPropagation();
              onResume(node, info);
            }}
          >
            Resume
          </button>
        ) : (
          <span
            className="flex-none tabular-nums"
            style={recencyTimestampStyle(
              lastActive,
              Date.now(),
              page.statusFg,
              page.fg,
              page.bg,
            )}
          >
            {formatAge(lastActive)}
          </span>
        )}
      </span>
    </>
  );

  // A running card IS a <button> (it has no nested controls). An exited ghost
  // does nothing on click, so it's a native group — <fieldset> — whose Resume
  // button stays reachable to assistive tech (a button would hide it).
  return exited ? (
    <fieldset {...shared} className={`${shared.className} m-0 min-w-0`}>
      {content}
    </fieldset>
  ) : (
    <button
      type="button"
      {...shared}
      className={`${shared.className} text-left`}
      onClick={() => onOpen(node)}
    >
      {content}
    </button>
  );
}

// ── Canvas ───────────────────────────────────────────────────────

interface Flat {
  node: AgentTreeNode;
  managerName?: string;
}

function flatten(roots: AgentTreeNode[]): Flat[] {
  const out: Flat[] = [];
  const walk = (n: AgentTreeNode, managerName?: string) => {
    out.push({ node: n, managerName });
    for (const c of n.children) walk(c, n.name);
  };
  for (const r of roots) walk(r);
  return out;
}

function OrgCanvas({
  roots,
  tokens,
  page,
  statusMap,
  onOpen,
  onResume,
  onMenu,
}: {
  roots: AgentTreeNode[];
  tokens: OrgChartTokens;
  page: PageTheme;
  statusMap: Record<string, AgentInfo>;
  onOpen: (node: AgentTreeNode) => void;
  onResume: (node: AgentTreeNode, info?: AgentInfo) => void;
  onMenu: (target: AgentMenuTarget, x: number, y: number) => void;
}) {
  const notificationCounts = useStore((s) => s.notificationCounts);
  const layout = useMemo(() => layoutOrg(roots), [roots]);
  const flat = useMemo(() => flatten(roots), [roots]);
  const exitedIds = useMemo(
    () =>
      new Set(
        flat.filter((f) => f.node.status !== "running").map((f) => f.node.id),
      ),
    [flat],
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-org-viewport>
      <div
        data-org-stage
        className="relative"
        // Centered while it fits; auto margins collapse to 0 once the stage
        // is wider than the pane, so an overflowing fleet still scrolls from
        // its left edge.
        style={{ width: layout.width, height: layout.height, margin: "0 auto" }}
      >
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-visible"
          width={layout.width}
          height={layout.height}
        >
          {layout.edges.map(({ from, to }) => {
            const a = layout.pos.get(from);
            const b = layout.pos.get(to);
            if (!a || !b) return null;
            const dashed = exitedIds.has(from) || exitedIds.has(to);
            return (
              <path
                key={`${from}>${to}`}
                data-org-edge={`${from}>${to}`}
                d={elbowPath(a, b)}
                fill="none"
                className="org-edge"
                stroke={tokens.edge}
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeDasharray={dashed ? "4 4" : undefined}
              />
            );
          })}
        </svg>
        {layout.shelf && (
          <div
            data-org-shelf
            className="absolute text-[10.5px] font-semibold uppercase tracking-[0.07em]"
            style={{ left: PAD, top: layout.shelf.y, color: tokens.muted }}
          >
            Unassigned · {layout.shelf.count}
          </div>
        )}
        {flat.map(({ node, managerName }) => {
          const p = layout.pos.get(node.id);
          if (!p) return null;
          const info = statusMap[node.claudeSessionId];
          return (
            <OrgCard
              key={node.id}
              node={node}
              x={p.x}
              y={p.y}
              managerName={managerName}
              info={info}
              unread={
                node.status === "running"
                  ? (notificationCounts[info?.session.id ?? node.id] ?? 0)
                  : 0
              }
              tokens={tokens}
              page={page}
              onOpen={onOpen}
              onResume={onResume}
              onMenu={onMenu}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Toolbar: who needs you + exited toggle ───────────────────────

function Toolbar({
  waiting,
  hiddenExited,
  showAllExited,
  onToggleExited,
  onOpen,
  tokens,
}: {
  waiting: Array<{ node: AgentTreeNode; tool?: string }>;
  hiddenExited: number;
  showAllExited: boolean;
  onToggleExited: () => void;
  onOpen: (node: AgentTreeNode) => void;
  tokens: OrgChartTokens;
}) {
  const showToggle = hiddenExited > 0 || showAllExited;
  if (waiting.length === 0 && !showToggle) return null;
  const amber = tokens.status.needsInput;
  return (
    <div
      data-org-toolbar
      className="flex min-h-10 flex-wrap items-center gap-2 px-3 py-2 text-[11.5px]"
      style={{ borderBottom: `1px solid ${tokens.cardBorder}` }}
    >
      {waiting.length > 0 && (
        <>
          <span className="font-semibold" style={{ color: amber }}>
            {waiting.length} need{waiting.length === 1 ? "s" : ""} you
          </span>
          {waiting.map(({ node, tool }) => (
            <button
              key={node.id}
              type="button"
              data-org-waiting={node.id}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-0.5"
              style={{
                color: amber,
                border: `1px solid ${amber}`,
                background: `${amber}17`,
              }}
              onClick={() => onOpen(node)}
            >
              <b>{node.name}</b>
              {tool && <span style={{ opacity: 0.85 }}>{tool}</span>}
            </button>
          ))}
        </>
      )}
      <span className="flex-1" />
      {showToggle && (
        <button
          type="button"
          data-org-exited-toggle
          aria-pressed={showAllExited}
          className="cursor-pointer rounded px-2 py-0.5"
          style={{
            color: tokens.muted,
            border: `1px solid ${tokens.cardBorder}`,
          }}
          onClick={onToggleExited}
        >
          {showAllExited ? "Hide exited" : `Show ${hiddenExited} exited`}
        </button>
      )}
    </div>
  );
}

// ── Main Panel ───────────────────────────────────────────────────

export function HierarchyPanel() {
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const tokens = useMemo(() => orgChartTokens(page), [page]);
  const statusMap = useAgentStatusById();
  const { chart, loading, error } = useOrgChart();
  const switchPane = useStore((s) => s.switchPane);
  const markNotificationsRead = useStore((s) => s.markNotificationsRead);
  const notificationCounts = useStore((s) => s.notificationCounts);
  const resumeSession = useStore((s) => s.resumeSession);
  const [showAllExited, setShowAllExited] = useState(false);
  const [menu, setMenu] = useState<{
    target: AgentMenuTarget;
    x: number;
    y: number;
  } | null>(null);

  const { roots, hiddenExited } = useMemo(
    () => pruneExited(chart, showAllExited),
    [chart, showAllExited],
  );

  const waiting = useMemo(
    () =>
      flatten(roots)
        .filter(
          ({ node }) =>
            node.status === "running" &&
            statusMap[node.claudeSessionId]?.agentStatus === "needs_input",
        )
        .map(({ node }) => ({
          node,
          tool: statusMap[node.claudeSessionId]?.currentTool,
        })),
    [roots, statusMap],
  );

  // Same path as a sidebar row click: switch to the pane, focus its terminal,
  // clear its unread count.
  const openAgent = useCallback(
    (node: AgentTreeNode) => {
      const id = statusMap[node.claudeSessionId]?.session.id ?? node.id;
      switchPane({ type: "session", id });
      focusTerminal(id);
      if (notificationCounts[id]) void markNotificationsRead(id);
    },
    [statusMap, switchPane, notificationCounts, markNotificationsRead],
  );

  const resumeAgent = useCallback(
    (node: AgentTreeNode, info?: AgentInfo) => {
      resumeSession(node.id, info?.session.workingDirectory ?? "", node.name, {
        isAutonomosAgent: true,
      }).catch(() => {
        // resumeSession records the failure in the store's status line.
      });
    },
    [resumeSession],
  );

  const openMenu = useCallback(
    (target: AgentMenuTarget, x: number, y: number) =>
      setMenu({ target, x, y }),
    [],
  );
  // Stable identity: the menu registers onClose on the ADR-065 escape stack
  // keyed by it — a fresh function per render would churn that registration.
  const closeMenu = useCallback(() => setMenu(null), []);

  let body: React.ReactNode;
  if (loading) {
    body = (
      <div
        className="flex flex-1 items-center justify-center text-sm"
        style={{ color: tokens.muted }}
      >
        Loading...
      </div>
    );
  } else if (error) {
    body = (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 text-sm"
        style={{ color: tokens.status.error }}
      >
        <span>{error}</span>
        <span className="text-xs opacity-60" style={{ color: tokens.muted }}>
          Retrying automatically...
        </span>
      </div>
    );
  } else if (roots.length === 0) {
    body = (
      <div
        className="flex flex-1 flex-col items-center justify-center gap-2 text-sm"
        style={{ color: tokens.muted }}
      >
        <span>No agents running</span>
        <span className="text-xs opacity-60">
          Create an agent, then ask it to spawn helpers — managers and their
          reports appear here
        </span>
      </div>
    );
  } else {
    body = (
      <OrgCanvas
        roots={roots}
        tokens={tokens}
        page={page}
        statusMap={statusMap}
        onOpen={openAgent}
        onResume={resumeAgent}
        onMenu={openMenu}
      />
    );
  }

  return (
    <div
      data-org-chart
      className="flex h-full w-full flex-col"
      style={{ background: page.bg, color: tokens.fg }}
    >
      {!loading && !error && (
        <Toolbar
          waiting={waiting}
          hiddenExited={hiddenExited}
          showAllExited={showAllExited}
          onToggleExited={() => setShowAllExited((v) => !v)}
          onOpen={openAgent}
          tokens={tokens}
        />
      )}
      {body}
      {/* Portaled to <body>: the menu is position:fixed at viewport coords,
          but dockview wraps every pane in `.dv-render-overlay`, whose
          transform + `contain: layout paint` make the PANE the containing
          block — rendered in place, the menu lands offset by the sidebar width
          and header height. Mounted only while open: push-on-open, pop-on-close
          on the escape stack. */}
      {menu &&
        createPortal(
          <AgentContextMenu
            target={menu.target}
            x={menu.x}
            y={menu.y}
            page={page}
            onClose={closeMenu}
          />,
          document.body,
        )}
    </div>
  );
}
