import { type AgentTreeNode, PERMISSION_MODE_INFO } from "@autonomos/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { orgTreePoll } from "../api/polls";
import { usePoll } from "../api/usePoll";
import { focusTerminal } from "../hooks/useTerminal";
import { pushEscapeCloser } from "../shortcuts/escapeStack";
import type { SessionInfo } from "../store";
import { THEMES, useStore } from "../store";
import { AgentContextMenu, type AgentMenuTarget } from "./AgentContextMenu";
import { CARD_H, CARD_W, elbowPath, layoutOrg, PAD } from "./orgchart/layout";
import { pruneExited } from "./orgchart/pruneExited";
import {
  applyCollapse,
  computeRollups,
  type RollupBucket,
  type TeamRollup,
} from "./orgchart/teams";
import { type OrgChartTokens, orgChartTokens } from "./orgchart/theme";
import {
  formatAge,
  recencyLabelOpacity,
  recencyTimestampStyle,
} from "./recency";
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
  /** Selection role: the selected card, a card on its manager chain / in its
   *  team, a card outside it (dimmed), or no selection at all. */
  selection: "self" | "chain" | "dim" | null;
  onOpen: (node: AgentTreeNode) => void;
  onSelect: (id: string | null) => void;
  onNavigate: (id: string, dir: NavDir) => void;
  onResume: (node: AgentTreeNode, info?: AgentInfo) => void;
  onMenu: (target: AgentMenuTarget, x: number, y: number) => void;
}

type NavDir = "up" | "down" | "left" | "right";
const NAV_KEYS: Record<string, NavDir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

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
  selection,
  onOpen,
  onSelect,
  onNavigate,
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
    "aria-label": `${node.name}, ${label}${unread > 0 ? `, ${unread} unread` : ""}. ${
      exited ? "" : "Enter opens the terminal; "
    }arrows move; Shift+F10 for actions.`,
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
      cursor: "pointer",
      // The focus outline (focus-visible:outline-2) and the SELECTED outline
      // share the theme's slate, so selection reads as the app's own mark.
      outlineColor: tokens.status.active,
      ...(selection === "self"
        ? { outline: `2px solid ${tokens.status.active}`, outlineOffset: 3 }
        : {}),
      opacity: selection === "dim" ? tokens.dimOpacity : undefined,
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
    // Click SELECTS (Terry's pick: the chart stays put). Opening the terminal
    // is always explicit: double-click, Enter, or the inspector's button.
    onClick: () => onSelect(node.id),
    onDoubleClick: () => {
      if (!exited) onOpen(node);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      const dir = NAV_KEYS[e.key];
      if (dir) {
        e.preventDefault();
        onNavigate(node.id, dir);
      } else if (e.key === "Enter") {
        // preventDefault stops the native <button> click (which would select).
        e.preventDefault();
        if (exited) onSelect(node.id);
        else onOpen(node);
      } else if (e.key === " " && exited) {
        // Space is the native click on a running <button>; a fieldset has none.
        e.preventDefault();
        onSelect(node.id);
      } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
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
        <span
          className="flex-none"
          style={{ opacity: exited ? tokens.ghostTextOpacity : 1 }}
        >
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
          style={{ opacity: exited ? tokens.ghostTextOpacity : 1 }}
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
            // #383's rule, shared with the sidebar: only an at-rest (idle)
            // label fades with age; attention and work never recede.
            opacity: exited
              ? undefined
              : recencyLabelOpacity(status, lastActive, Date.now(), page.bg),
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
  // is a native group — <fieldset> — so its nested Resume button stays
  // reachable to assistive tech (a button would hide it).
  return exited ? (
    <fieldset
      {...shared}
      aria-current={selection === "self" ? "true" : undefined}
      className={`${shared.className} m-0 min-w-0`}
    >
      {content}
    </fieldset>
  ) : (
    <button
      type="button"
      {...shared}
      aria-pressed={selection === "self"}
      className={`${shared.className} text-left`}
    >
      {content}
    </button>
  );
}

// ── Canvas ───────────────────────────────────────────────────────

interface Flat {
  node: AgentTreeNode;
  managerName?: string;
  managerId?: string;
}

function flatten(roots: AgentTreeNode[]): Flat[] {
  const out: Flat[] = [];
  const walk = (n: AgentTreeNode, manager?: AgentTreeNode) => {
    out.push({ node: n, managerName: manager?.name, managerId: manager?.id });
    for (const c of n.children) walk(c, n);
  };
  for (const r of roots) walk(r);
  return out;
}

/** The selected agent plus its manager chain and its whole team. */
function selectionChain(flat: Flat[], selectedId: string): Set<string> {
  const byId = new Map(flat.map((f) => [f.node.id, f]));
  const chain = new Set<string>([selectedId]);
  let up = byId.get(selectedId)?.managerId;
  while (up) {
    chain.add(up);
    up = byId.get(up)?.managerId;
  }
  const down = (n: AgentTreeNode) => {
    for (const c of n.children) {
      chain.add(c.id);
      down(c);
    }
  };
  const self = byId.get(selectedId)?.node;
  if (self) down(self);
  return chain;
}

function OrgCanvas({
  roots,
  rollups,
  collapsed,
  onToggleCollapse,
  tokens,
  page,
  statusMap,
  selectedId,
  selectionChainIds,
  onSelect,
  onOpen,
  onResume,
  onMenu,
}: {
  /** The tree AS DRAWN — collapsed teams already folded. */
  roots: AgentTreeNode[];
  /** Per-manager rollups, computed BEFORE folding. */
  rollups: Map<string, TeamRollup>;
  collapsed: ReadonlySet<string>;
  onToggleCollapse: (id: string) => void;
  tokens: OrgChartTokens;
  page: PageTheme;
  statusMap: Record<string, AgentInfo>;
  selectedId: string | null;
  /** Selected agent + manager chain + team, from the unfolded tree. */
  selectionChainIds: Set<string> | null;
  onSelect: (id: string | null) => void;
  onOpen: (node: AgentTreeNode) => void;
  onResume: (node: AgentTreeNode, info?: AgentInfo) => void;
  onMenu: (target: AgentMenuTarget, x: number, y: number) => void;
}) {
  const notificationCounts = useStore((s) => s.notificationCounts);
  const layout = useMemo(
    () =>
      layoutOrg(roots, {
        isTeam: (n) => collapsed.has(n.id) && rollups.has(n.id),
      }),
    [roots, collapsed, rollups],
  );
  const flat = useMemo(() => flatten(roots), [roots]);
  const exitedIds = useMemo(
    () =>
      new Set(
        flat.filter((f) => f.node.status !== "running").map((f) => f.node.id),
      ),
    [flat],
  );
  // The chain comes from the panel, computed on the UNFOLDED tree: a selected
  // agent folded away still lights its (drawn) lead instead of dimming all.
  const chain = selectionChainIds;

  // Arrow keys walk the chart: ↑ manager, ↓ first report, ←/→ the neighbor on
  // the same row. Focus follows the selection so the keys keep working.
  const navigate = useCallback(
    (id: string, dir: NavDir) => {
      const me = flat.find((f) => f.node.id === id);
      const at = layout.pos.get(id);
      if (!me || !at) return;
      let to: string | undefined;
      if (dir === "up") to = me.managerId;
      else if (dir === "down") to = me.node.children[0]?.id;
      else {
        const row = flat
          .map((f) => ({ id: f.node.id, p: layout.pos.get(f.node.id) }))
          .filter((r) => r.p && r.p.y === at.y)
          .sort((a, b) => (a.p?.x ?? 0) - (b.p?.x ?? 0));
        const i = row.findIndex((r) => r.id === id);
        to = row[i + (dir === "left" ? -1 : 1)]?.id;
      }
      if (!to) return;
      onSelect(to);
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-org-card="${CSS.escape(to)}"]`)
          ?.focus(),
      );
    },
    [flat, layout, onSelect],
  );

  // Clicking empty canvas clears the selection (a pointer nicety — the
  // keyboard path is Esc via the escape stack). Native listener: the viewport
  // is a plain scroll container, not an interactive element.
  const viewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest("[data-org-card], button")) onSelect(null);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [onSelect]);

  return (
    <div
      ref={viewportRef}
      className="min-h-0 flex-1 overflow-auto"
      data-org-viewport
    >
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
            const lit = chain?.has(from) && chain.has(to);
            return (
              <path
                key={`${from}>${to}`}
                data-org-edge={`${from}>${to}`}
                d={elbowPath(a, b)}
                fill="none"
                className="org-edge"
                stroke={lit ? tokens.status.active : tokens.edge}
                strokeWidth={lit ? 2 : 1.6}
                opacity={chain && !lit ? tokens.dimOpacity : undefined}
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
        {/* A folded team reads as a small stack of cards behind its lead. */}
        {flat.map(({ node }) => {
          const p = layout.pos.get(node.id);
          if (!p || !collapsed.has(node.id) || !rollups.has(node.id))
            return null;
          return [10, 5].map((d) => (
            <div
              key={`${node.id}-stack-${d}`}
              data-org-stack={node.id}
              aria-hidden="true"
              className="org-card absolute rounded-[9px]"
              style={{
                left: p.x + d,
                top: p.y + d,
                width: CARD_W,
                height: CARD_H,
                background: tokens.card,
                border: `1px solid ${tokens.cardBorder}`,
                opacity: d === 10 ? 0.45 : 0.75,
              }}
            />
          ));
        })}
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
              selection={
                !chain
                  ? null
                  : node.id === selectedId
                    ? "self"
                    : chain.has(node.id)
                      ? "chain"
                      : "dim"
              }
              onOpen={onOpen}
              onSelect={onSelect}
              onNavigate={navigate}
              onResume={onResume}
              onMenu={onMenu}
            />
          );
        })}
        {flat.map(({ node }) => {
          const p = layout.pos.get(node.id);
          const rollup = rollups.get(node.id);
          if (!p || !rollup) return null;
          const folded = collapsed.has(node.id);
          return (
            <TeamControls
              key={`${node.id}-team`}
              node={node}
              x={p.x}
              y={p.y}
              rollup={rollup}
              folded={folded}
              tokens={tokens}
              onToggle={onToggleCollapse}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Inspector: the selected agent, docked beside the chart ───────

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

function OrgInspector({
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

/**
 * A lead's team summary (chips above the card) and its collapse toggle (on the
 * card's bottom edge, where the connector leaves). Siblings of the card, not
 * children: the card is a <button> and can't contain another button.
 */
function TeamControls({
  node,
  x,
  y,
  rollup,
  folded,
  tokens,
  onToggle,
}: {
  node: AgentTreeNode;
  x: number;
  y: number;
  rollup: TeamRollup;
  folded: boolean;
  tokens: OrgChartTokens;
  onToggle: (id: string) => void;
}) {
  const chips: Array<{
    key: string;
    text: string;
    color: string;
    strong?: boolean;
  }> = [];
  if (rollup.needsYou > 0)
    chips.push({
      key: "needs",
      text: `${rollup.needsYou} need${rollup.needsYou === 1 ? "s" : ""} you`,
      color: tokens.status.needsInput,
      strong: true,
    });
  if (rollup.error > 0)
    chips.push({
      key: "error",
      text: `${rollup.error} error`,
      color: tokens.status.error,
    });
  if (rollup.working > 0)
    chips.push({
      key: "working",
      text: `${rollup.working} working`,
      color: tokens.status.active,
    });
  if (rollup.idle > 0)
    chips.push({
      key: "idle",
      text: `${rollup.idle} idle`,
      color: tokens.status.ready,
    });
  if (rollup.exited > 0)
    chips.push({
      key: "exited",
      text: `${rollup.exited} exited`,
      color: tokens.muted,
    });

  // At most three chips, by priority (needs-you, error, working first): five
  // would run under the neighbor lead's chips (cards sit CARD_W + H_GAP apart)
  // and could hide ITS amber. The rest fold into a "+N" chip with a tooltip.
  const shown = chips.slice(0, 3);
  const rest = chips.slice(3);
  return (
    <>
      <div
        data-org-rollup={node.id}
        className="org-card pointer-events-none absolute flex gap-1 whitespace-nowrap text-[10px] tabular-nums"
        style={{
          left: x + 2,
          top: y - 19,
          maxWidth: CARD_W,
          overflow: "hidden",
        }}
      >
        {shown.map((c) => (
          <span
            key={c.key}
            className="rounded-full px-1.5 leading-4"
            style={{
              color: c.color,
              // Opaque: the chips sit over the incoming connector.
              background: tokens.bg,
              border: `1px solid ${c.strong ? c.color : tokens.cardBorder}`,
              fontWeight: c.strong ? 600 : undefined,
            }}
          >
            {c.text}
          </span>
        ))}
        {rest.length > 0 && (
          <span
            data-org-rollup-more
            title={rest.map((c) => c.text).join(" · ")}
            className="rounded-full px-1.5 leading-4"
            style={{
              color: tokens.muted,
              background: tokens.bg,
              border: `1px solid ${tokens.cardBorder}`,
            }}
          >
            +{rest.length}
          </span>
        )}
      </div>
      <button
        type="button"
        data-org-collapse={node.id}
        aria-expanded={!folded}
        aria-label={`${folded ? "Expand" : "Collapse"} ${node.name}'s team (${rollup.total})`}
        title={folded ? `Show ${rollup.total} in team` : "Collapse team"}
        className="org-card absolute flex h-[18px] min-w-[22px] cursor-pointer items-center justify-center rounded-full px-1.5 text-[10px] leading-none tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1"
        style={{
          left: x + CARD_W / 2 - 11,
          top: y + CARD_H - 9,
          color: tokens.muted,
          // Opaque page color so the toggle sits cleanly ON the connector.
          background: tokens.bg,
          border: `1px solid ${tokens.cardBorder}`,
          outlineColor: tokens.status.active,
          zIndex: 1,
        }}
        onClick={() => onToggle(node.id)}
      >
        {folded ? `+${rollup.total}` : "▾"}
      </button>
    </>
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

// ── Team state ───────────────────────────────────────────────────

function rollupBucket(node: AgentTreeNode, info?: AgentInfo): RollupBucket {
  if (node.status !== "running") return "exited";
  const status = info?.agentStatus ?? "unknown";
  if (status === "needs_input") return "needsYou";
  if (status === "error") return "error";
  // "Working" is the sidebar's shimmer set — one definition (ADR-090).
  if (statusLabelStyle(status, false).shimmer) return "working";
  return "idle";
}

const COLLAPSED_KEY = "autonomos.orgchart.collapsed";

/**
 * Which teams are folded, remembered per manager id in this browser. Storage
 * can be unavailable (private window, blocked site data) — then it just
 * doesn't persist. A stale id (a deleted manager) is ignored by applyCollapse.
 */
function useCollapsedTeams(): [ReadonlySet<string>, (id: string) => void] {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      const ids: unknown = raw ? JSON.parse(raw) : [];
      return new Set(
        Array.isArray(ids) ? ids.filter((x) => typeof x === "string") : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Not persisted this session; the toggle still works.
      }
      return next;
    });
  }, []);
  return [collapsed, toggle];
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
  const restartSession = useStore((s) => s.restartSession);
  const [showAllExited, setShowAllExited] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [engaged, setEngaged] = useState(false);
  // Every selection comes from an interaction IN the chart (a card, an arrow
  // key, an inspector chip, a bubble), so selecting also marks it engaged.
  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    if (id) setEngaged(true);
  }, []);
  const [menu, setMenu] = useState<{
    target: AgentMenuTarget;
    x: number;
    y: number;
  } | null>(null);

  const { roots, hiddenExited } = useMemo(
    () => pruneExited(chart, showAllExited),
    [chart, showAllExited],
  );
  const [collapsed, toggleCollapsed] = useCollapsedTeams();
  // Rollups count the tree as DRAWN (after pruning) but BEFORE folding, so a
  // collapsed lead still says who in its team needs you.
  const rollups = useMemo(
    () =>
      computeRollups(roots, (node) =>
        rollupBucket(node, statusMap[node.claudeSessionId]),
      ),
    [roots, statusMap],
  );
  const drawn = useMemo(
    () => applyCollapse(roots, collapsed),
    [roots, collapsed],
  );

  const flatRoots = useMemo(() => flatten(roots), [roots]);
  const selectionChainIds = useMemo(
    () => (selectedId ? selectionChain(flatRoots, selectedId) : null),
    [flatRoots, selectedId],
  );
  const selected = selectedId
    ? flatRoots.find((f) => f.node.id === selectedId)
    : undefined;
  // A selection whose agent left the drawn tree (deleted, or hidden by the
  // exited toggle) clears itself.
  useEffect(() => {
    if (selectedId && !selected) setSelectedId(null);
  }, [selectedId, selected]);
  // Esc clears the selection through the ADR-065 escape stack — but ONLY while
  // the user is actually in the chart. Dockview keeps this panel mounted while
  // hidden, so a selection alone must not reserve Escape: otherwise the first
  // Esc typed into a terminal (to interrupt a turn) silently clears a chart you
  // can't see. "Engaged" = the last focus or pointer-down landed inside the
  // chart; the tracking listeners live only while a selection exists.
  const chartRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selectedId) return;
    const track = (e: Event) =>
      setEngaged(!!chartRef.current?.contains(e.target as Node | null));
    window.addEventListener("focusin", track, true);
    window.addEventListener("pointerdown", track, true);
    return () => {
      window.removeEventListener("focusin", track, true);
      window.removeEventListener("pointerdown", track, true);
    };
  }, [selectedId]);
  useEffect(() => {
    if (!selectedId || !engaged) return;
    return pushEscapeCloser(() => setSelectedId(null));
  }, [selectedId, engaged]);

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
      // Leaving for the terminal ends the chart interaction: drop the
      // selection so nothing on the hidden chart competes for Escape.
      setSelectedId(null);
      setEngaged(false);
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
        roots={drawn}
        rollups={rollups}
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        selectedId={selectedId}
        selectionChainIds={selectionChainIds}
        onSelect={select}
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
      ref={chartRef}
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
      <div className="flex min-h-0 flex-1">
        {body}
        {selected && !loading && !error && (
          <OrgInspector
            node={selected.node}
            managerId={selected.managerId}
            managerName={selected.managerName}
            info={statusMap[selected.node.claudeSessionId]}
            unread={
              selected.node.status === "running"
                ? (notificationCounts[
                    statusMap[selected.node.claudeSessionId]?.session.id ??
                      selected.node.id
                  ] ?? 0)
                : 0
            }
            tokens={tokens}
            page={page}
            statusMap={statusMap}
            onSelect={select}
            onOpen={openAgent}
            onResume={resumeAgent}
            onRestart={(id) => void restartSession(id)}
            onMenu={openMenu}
          />
        )}
      </div>
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
