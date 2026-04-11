import React, { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { focusTerminal } from "../hooks/useTerminal";
import {
  DRAG_TYPE,
  encodeDragData,
  useDragContext,
} from "../layout/DragContext";
import { allTabPanes } from "../layout/layoutTree";
import type {
  ActivePane,
  PreviewPaneInfo,
  ProjectInfo,
  SessionInfo,
} from "../store";
import { buildSidebarItems, sidebarItemPane, THEMES, useStore } from "../store";
import { Codicon } from "./Codicon";
import {
  type AgentStatus,
  AgentStatusIcon,
  agentStatusLabel,
} from "./ui/agent-status-icon";

/** Select data fields that change over time — useShallow prevents re-renders when values are equal */
function useSidebarData() {
  return useStore(
    useShallow((s) => ({
      theme: s.theme,
      sessions: s.sessions,
      projects: s.projects,
      activePane: s.activePane,
      paneOrder: s.paneOrder,
      previewPanes: s.previewPanes,
      status: s.status,
      notificationCounts: s.notificationCounts,
      agentStatuses: s.agentStatuses,
      layout: s.layout,
      exitedSessions: s.exitedSessions,
      showExitedAgents: s.showExitedAgents,
      sidebarViewMode: s.sidebarViewMode,
      hierarchyOrder: s.hierarchyOrder,
    })),
  );
}

/** Select store actions — useShallow needed because the selector returns a new object */
function useSidebarActions() {
  return useStore(
    useShallow((s) => ({
      fetchSessions: s.fetchSessions,
      fetchProjects: s.fetchProjects,
      createSession: s.createSession,
      switchPane: s.switchPane,
      closePreview: s.closePreview,
      reorderPanes: s.reorderPanes,
      fetchNotifications: s.fetchNotifications,
      markNotificationsRead: s.markNotificationsRead,
      openOrgChart: s.openOrgChart,
      openTemplates: s.openTemplates,
      toggleShowExitedAgents: s.toggleShowExitedAgents,
      toggleSidebarViewMode: s.toggleSidebarViewMode,
      reorderHierarchy: s.reorderHierarchy,
      removeSession: s.removeSession,
    })),
  );
}

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

// ── Display list types ──────────────────────────────────────────────────────

type DisplayItem =
  | { type: "session"; session: SessionInfo; pane: ActivePane }
  | { type: "preview"; preview: PreviewPaneInfo; pane: ActivePane };

// ── Hierarchy tree types ────────────────────────────────────────────────

interface OrgNode {
  name: string;
  template?: string;
  project?: string;
  children: OrgNode[];
}

interface SidebarHierarchyNode {
  /** The org chart node (name, template, children) */
  org: OrgNode;
  /** Matching live session, if any */
  session: SessionInfo | undefined;
  children: SidebarHierarchyNode[];
}

/**
 * Merge org chart tree with live sessions.
 * Each org node is matched to a live session by name (case-insensitive).
 * When hideStopped is true, prune nodes that have no live session AND
 * no descendants with live sessions.
 */
function mergeOrgWithSessions(
  orgRoots: OrgNode[],
  sessions: SessionInfo[],
  hideStopped: boolean,
  order: Record<string, string[]>,
): SidebarHierarchyNode[] {
  const sessionByName = new Map<string, SessionInfo>();
  for (const s of sessions) {
    sessionByName.set(s.name.toLowerCase(), s);
  }

  /** Sort nodes according to stored order for a given group key */
  function applyOrder(
    nodes: SidebarHierarchyNode[],
    groupKey: string,
  ): SidebarHierarchyNode[] {
    const savedOrder = order[groupKey];
    if (!savedOrder || savedOrder.length === 0) return nodes;
    const byName = new Map<string, SidebarHierarchyNode>();
    for (const n of nodes) byName.set(n.org.name.toLowerCase(), n);
    const result: SidebarHierarchyNode[] = [];
    const placed = new Set<string>();
    for (const name of savedOrder) {
      const key = name.toLowerCase();
      const node = byName.get(key);
      if (node) {
        result.push(node);
        placed.add(key);
      }
    }
    // Append any new nodes not in saved order
    for (const n of nodes) {
      if (!placed.has(n.org.name.toLowerCase())) result.push(n);
    }
    return result;
  }

  function merge(node: OrgNode): SidebarHierarchyNode {
    const children = node.children.map(merge);
    const groupKey = node.name.toLowerCase();
    return {
      org: node,
      session: sessionByName.get(groupKey),
      children: applyOrder(children, groupKey),
    };
  }

  /** Returns true if node or any descendant has a live session */
  function hasLiveDescendant(node: SidebarHierarchyNode): boolean {
    if (node.session) return true;
    return node.children.some(hasLiveDescendant);
  }

  /** Recursively filter out stopped-only subtrees */
  function prune(node: SidebarHierarchyNode): SidebarHierarchyNode | null {
    if (!hasLiveDescendant(node)) return null;
    return {
      ...node,
      children: node.children
        .map(prune)
        .filter(Boolean) as SidebarHierarchyNode[],
    };
  }

  const merged = applyOrder(orgRoots.map(merge), "__root__");
  if (!hideStopped) return merged;
  return merged.map(prune).filter(Boolean) as SidebarHierarchyNode[];
}

/** Hook to poll the org chart endpoint */
function useOrgChartData() {
  const [chart, setChart] = useState<OrgNode[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function fetchChart() {
      try {
        const res = await fetch("/api/org");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data)) setChart(data);
      } catch {
        // silently retry
      }
    }

    fetchChart();
    const interval = setInterval(fetchChart, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return chart;
}

function _DiffStat({
  stat,
}: {
  stat: { insertions: number; deletions: number };
}) {
  return (
    <span className="shrink-0 text-[10px]">
      <span style={{ color: "#91b362" }}>+{stat.insertions}</span>{" "}
      <span style={{ color: "#ea6c73" }}>-{stat.deletions}</span>
    </span>
  );
}

export function Sidebar() {
  const {
    theme,
    sessions,
    projects,
    activePane,
    paneOrder,
    previewPanes,
    status,
    notificationCounts,
    agentStatuses,
    layout,
    exitedSessions,
    showExitedAgents,
    sidebarViewMode,
    hierarchyOrder,
  } = useSidebarData();
  const {
    fetchSessions,
    fetchProjects,
    createSession,
    switchPane,
    closePreview,
    reorderPanes,
    fetchNotifications,
    markNotificationsRead,
    openOrgChart,
    openTemplates,
    toggleShowExitedAgents,
    toggleSidebarViewMode,
    reorderHierarchy,
    removeSession,
  } = useSidebarActions();
  const page = THEMES[theme].page;

  const isSpawning = status === "spawning...";
  const { startDrag, endDrag } = useDragContext();

  // Set of pane IDs currently visible on screen (active tab in each leaf)
  const visiblePaneIds = useMemo(() => {
    const ids = new Set<string>();
    for (const p of allTabPanes(layout)) ids.add(p.id);
    return ids;
  }, [layout]);

  const sidebarItems = useMemo(
    () => buildSidebarItems(sessions, previewPanes, paneOrder),
    [sessions, previewPanes, paneOrder],
  );

  // Flat display list — no group containers, just sessions and previews in order.
  const displayItems = useMemo((): DisplayItem[] => {
    const result: DisplayItem[] = [];

    for (const item of sidebarItems) {
      const pane = sidebarItemPane(item);
      if (item.type === "preview") {
        result.push({ type: "preview", preview: item.data, pane });
      } else {
        result.push({ type: "session", session: item.data, pane });
      }
    }

    return result;
  }, [sidebarItems]);

  // Fetch org chart for hierarchy view
  const orgChart = useOrgChartData();

  // Merge org chart tree with live sessions (hide stopped when eye is off)
  const hierarchyTree = useMemo(
    () =>
      mergeOrgWithSessions(
        orgChart,
        sessions,
        !showExitedAgents,
        hierarchyOrder,
      ),
    [orgChart, sessions, showExitedAgents, hierarchyOrder],
  );

  // Collapsed state for hierarchy groups (manager name → collapsed)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    new Set(),
  );
  const toggleCollapsed = (name: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Shared drag state for hierarchy reordering
  const hierDrag = useRef<{ group: string; idx: number } | null>(null);
  const [hierDropTarget, setHierDropTarget] = useState<{
    group: string;
    idx: number;
  } | null>(null);

  // Build a lookup map from claudeSessionId → enriched project session data.
  const sessionMetaMap = useMemo(() => {
    const map = new Map<
      string,
      {
        summary?: string;
        projectName?: string;
        gitBranch?: string;
        lastModified: number;
        gitDiffStat?: { insertions: number; deletions: number };
      }
    >();
    for (const p of projects) {
      for (const ps of p.sessions) {
        map.set(ps.sessionId, {
          summary: ps.summary,
          projectName: p.name,
          gitBranch: ps.gitBranch,
          lastModified: ps.lastModified,
          gitDiffStat: ps.gitDiffStat,
        });
      }
    }
    return map;
  }, [projects]);

  // Set of claudeSessionIds that have active live sessions.
  const liveSessionIds = useMemo(() => {
    const set = new Set<string>();
    for (const s of sessions) {
      if (s.claudeSessionId) set.add(s.claudeSessionId);
    }
    return set;
  }, [sessions]);

  // Poll live sessions every 5s, projects every 30s, notifications every 3s
  useEffect(() => {
    fetchSessions();
    fetchProjects();
    fetchNotifications();
    const sessionsInterval = setInterval(fetchSessions, 5000);
    const projectsInterval = setInterval(fetchProjects, 30000);
    const notifInterval = setInterval(fetchNotifications, 3000);
    return () => {
      clearInterval(sessionsInterval);
      clearInterval(projectsInterval);
      clearInterval(notifInterval);
    };
  }, [fetchSessions, fetchProjects, fetchNotifications]);

  // Drag state
  const dragIdx = useRef<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);
  // Confirm-remove state for exited agents
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  function handleDragStart(e: React.DragEvent, idx: number, pane: ActivePane) {
    dragIdx.current = idx;
    const data = { pane };
    e.dataTransfer.setData(DRAG_TYPE, encodeDragData(data));
    e.dataTransfer.effectAllowed = "move";
    startDrag(data);
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    setDropIdx(idx);
  }

  function handleDrop(idx: number) {
    if (dragIdx.current !== null && dragIdx.current !== idx) {
      reorderPanes(dragIdx.current, idx);
    }
    dragIdx.current = null;
    setDropIdx(null);
  }

  function handleDragEnd() {
    dragIdx.current = null;
    setDropIdx(null);
    endDrag();
  }

  function isPaneActive(pane: ActivePane): boolean {
    if (!activePane) return false;
    return activePane.type === pane.type && activePane.id === pane.id;
  }

  return (
    <aside
      className="absolute inset-y-0 left-0 z-20 flex w-56 shrink-0 flex-col overflow-y-auto md:relative md:w-64"
      style={{
        borderRight: `1px solid ${page.border}`,
        background: page.bg,
      }}
    >
      {/* Singleton pane buttons */}
      <SidebarNavButton
        label="Org Chart"
        active={activePane?.type === "orgchart"}
        page={page}
        onClick={openOrgChart}
      />
      <SidebarNavButton
        label="Templates"
        active={activePane?.type === "templates"}
        page={page}
        onClick={openTemplates}
      />

      {/* Agents section header + toggle + New button */}
      <div
        className="flex items-center gap-1.5 px-3 py-1.5"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <span
          className="text-xs font-medium uppercase flex-1"
          style={{ color: page.statusFg }}
        >
          Agents
        </span>
        <button
          type="button"
          onClick={toggleSidebarViewMode}
          className="text-[10px] cursor-pointer px-1 rounded transition-colors"
          style={{
            color: sidebarViewMode === "hierarchy" ? page.fg : page.statusFg,
          }}
          title={
            sidebarViewMode === "flat"
              ? "Switch to hierarchy view"
              : "Switch to flat view"
          }
        >
          <Codicon
            name={sidebarViewMode === "flat" ? "list-tree" : "list-flat"}
            size={12}
          />
        </button>
        {exitedSessions.length > 0 && (
          <button
            type="button"
            onClick={toggleShowExitedAgents}
            className="text-[10px] cursor-pointer px-1 rounded transition-colors"
            style={{ color: page.statusFg }}
            title={
              showExitedAgents
                ? "Hide stopped agents"
                : `Show ${exitedSessions.length} stopped`
            }
          >
            <Codicon name={showExitedAgents ? "eye" : "eye-closed"} size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={() => createSession()}
          disabled={isSpawning}
          className="rounded px-2 py-0.5 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "#238636", color: "#fff" }}
          title="New Agent"
        >
          + New
        </button>
      </div>

      {sidebarViewMode === "flat" ? (
        /* ── Flat view (original) ─────────────────────────────── */
        <>
          <div className="py-1">
            {displayItems.length === 0 && (
              <p
                className="px-3 py-3 text-center text-xs"
                style={{ color: page.statusFg }}
              >
                No active agents
              </p>
            )}

            {displayItems.map((item, idx) => {
              if (item.type === "session") {
                return (
                  <SessionRow
                    key={`s-${item.session.id}`}
                    session={item.session}
                    pane={item.pane}
                    idx={idx}
                    page={page}
                    isActive={isPaneActive(item.pane)}
                    isVisible={visiblePaneIds.has(item.pane.id)}
                    isDropTarget={dropIdx === idx}
                    meta={
                      item.session.claudeSessionId
                        ? sessionMetaMap.get(item.session.claudeSessionId)
                        : undefined
                    }
                    agentState={agentStatuses[item.session.id]}
                    notifCount={notificationCounts[item.session.id] ?? 0}
                    indent={0}
                    draggable
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onDragEnd={handleDragEnd}
                    onClick={() => {
                      switchPane(item.pane);
                      if (item.pane.type === "session")
                        focusTerminal(item.pane.id);
                      if (notificationCounts[item.session.id])
                        markNotificationsRead(item.session.id);
                    }}
                  />
                );
              }

              const p = item.preview;
              const pane = item.pane;
              const isActive = isPaneActive(pane);
              const isDropTarget = dropIdx === idx;
              return (
                // biome-ignore lint/a11y/useSemanticElements: nested interactive elements
                <div
                  key={`p-${p.id}`}
                  role="button"
                  tabIndex={-1}
                  onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
                  draggable
                  onDragStart={(e) => handleDragStart(e, idx, pane)}
                  onDragOver={(e) => handleDragOver(e, idx)}
                  onDrop={() => handleDrop(idx)}
                  onDragEnd={handleDragEnd}
                  className="group flex w-full items-center gap-1.5 px-3 py-1 cursor-pointer text-left"
                  style={{
                    background: isActive
                      ? page.border
                      : visiblePaneIds.has(pane.id)
                        ? `${page.border}80`
                        : "transparent",
                    ...(isDropTarget && {
                      boxShadow: `inset 0 2px 0 ${page.fg}`,
                    }),
                  }}
                  onClick={() => switchPane(pane)}
                  onKeyDown={(e) => e.key === "Enter" && switchPane(pane)}
                >
                  <Codicon name="markdown" size={12} />
                  <span className="flex-1 truncate text-xs">{p.title}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closePreview(p.id);
                    }}
                    className="shrink-0 rounded cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ color: page.statusFg }}
                    title="Close preview"
                  >
                    <Codicon name="close" size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Exited agents (toggleable) */}
          {showExitedAgents &&
            exitedSessions.map((s) => (
              <ExitedRow
                key={`exited-${s.id}`}
                session={s}
                page={page}
                confirmRemoveId={confirmRemoveId}
                onConfirmRemove={setConfirmRemoveId}
                onRemove={removeSession}
              />
            ))}
        </>
      ) : (
        /* ── Hierarchy view ───────────────────────────────────── */
        <div className="py-1">
          {hierarchyTree.length === 0 && (
            <p
              className="px-3 py-3 text-center text-xs"
              style={{ color: page.statusFg }}
            >
              No active agents
            </p>
          )}

          {hierarchyTree.map((node, idx) => (
            <HierarchyNodeRow
              key={node.org.name}
              node={node}
              depth={0}
              groupKey="__root__"
              indexInGroup={idx}
              page={page}
              isPaneActive={isPaneActive}
              visiblePaneIds={visiblePaneIds}
              sessionMetaMap={sessionMetaMap}
              agentStatuses={agentStatuses}
              notificationCounts={notificationCounts}
              collapsedGroups={collapsedGroups}
              toggleCollapsed={toggleCollapsed}
              switchPane={switchPane}
              markNotificationsRead={markNotificationsRead}
              onReorder={(gk, from, to) => {
                // Initialize order for this group if not yet stored
                const existing = hierarchyOrder[gk];
                if (!existing || existing.length === 0) {
                  // Determine current sibling names for this group
                  const siblings =
                    gk === "__root__"
                      ? hierarchyTree.map((n) => n.org.name.toLowerCase())
                      : (() => {
                          // Find parent node and get its children names
                          function findChildren(
                            nodes: SidebarHierarchyNode[],
                          ): string[] | null {
                            for (const n of nodes) {
                              if (n.org.name.toLowerCase() === gk)
                                return n.children.map((c) =>
                                  c.org.name.toLowerCase(),
                                );
                              const found = findChildren(n.children);
                              if (found) return found;
                            }
                            return null;
                          }
                          return findChildren(hierarchyTree) ?? [];
                        })();
                  // Set it first, then reorder
                  const order = [...siblings];
                  const [moved] = order.splice(from, 1);
                  order.splice(to, 0, moved);
                  useStore.setState((prev) => ({
                    hierarchyOrder: { ...prev.hierarchyOrder, [gk]: order },
                  }));
                } else {
                  reorderHierarchy(gk, from, to);
                }
              }}
              hierDrag={hierDrag}
              hierDropTarget={hierDropTarget}
              setHierDropTarget={setHierDropTarget}
            />
          ))}

          {/* Exited agents under hierarchy */}
          {showExitedAgents &&
            exitedSessions.map((s) => (
              <ExitedRow
                key={`exited-${s.id}`}
                session={s}
                page={page}
                confirmRemoveId={confirmRemoveId}
                onConfirmRemove={setConfirmRemoveId}
                onRemove={removeSession}
              />
            ))}
        </div>
      )}

      {/* Projects Section */}
      <div
        className="flex items-center px-3 py-2"
        style={{
          borderTop: `1px solid ${page.border}`,
          borderBottom: `1px solid ${page.border}`,
        }}
      >
        <span
          className="text-xs font-medium uppercase"
          style={{ color: page.statusFg }}
        >
          Projects
        </span>
      </div>

      <div className="flex-1 py-1">
        {projects.length === 0 && (
          <p
            className="px-3 py-3 text-center text-xs"
            style={{ color: page.statusFg }}
          >
            No projects found
          </p>
        )}

        {projects.map((project) => (
          <ProjectItem
            key={project.path}
            project={project}
            page={page}
            liveSessionIds={liveSessionIds}
          />
        ))}
      </div>
    </aside>
  );
}

function SidebarNavButton({
  label,
  active,
  page,
  onClick,
}: {
  label: string;
  active: boolean;
  page: PageTheme;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center px-3 py-2 w-full text-left cursor-pointer transition-colors"
      style={{
        borderBottom: `1px solid ${page.border}`,
        color: active ? page.fg : page.statusFg,
        background: active ? page.border : "transparent",
      }}
    >
      <span className="text-xs font-medium uppercase">{label}</span>
    </button>
  );
}

// ── Extracted row components ────────────────────────────────────────────

interface SessionRowProps {
  session: SessionInfo;
  pane: ActivePane;
  idx: number;
  page: PageTheme;
  isActive: boolean;
  isVisible: boolean;
  isDropTarget: boolean;
  meta?: {
    summary?: string;
    projectName?: string;
    gitBranch?: string;
    lastModified: number;
    gitDiffStat?: { insertions: number; deletions: number };
  };
  agentState?: { status: string; currentTool?: string; toolDetail?: string };
  notifCount: number;
  indent: number;
  /** Override the left border color (e.g. to indicate parent with children) */
  borderColor?: string;
  /** Callback when the left border zone is clicked (e.g. expand/collapse) */
  onBorderClick?: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, idx: number, pane: ActivePane) => void;
  onDragOver?: (e: React.DragEvent, idx: number) => void;
  onDrop?: (idx: number) => void;
  onDragEnd?: () => void;
  onClick: () => void;
}

function SessionRow({
  session: s,
  pane,
  idx,
  page,
  isActive,
  isVisible,
  isDropTarget,
  meta,
  agentState,
  notifCount,
  indent,
  borderColor,
  onBorderClick,
  draggable: isDraggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onClick,
}: SessionRowProps) {
  const lastActive = meta?.lastModified ?? s.createdAt;
  const paddingLeft = 9 + indent * 10;

  return (
    // biome-ignore lint/a11y/useSemanticElements: nested interactive elements
    <div
      role="button"
      tabIndex={-1}
      onMouseDown={(e: React.MouseEvent) => {
        if (!(e.currentTarget as HTMLElement).draggable) e.preventDefault();
      }}
      draggable={isDraggable}
      onDragStart={
        isDraggable && onDragStart
          ? (e) => onDragStart(e, idx, pane)
          : undefined
      }
      onDragOver={
        isDraggable && onDragOver ? (e) => onDragOver(e, idx) : undefined
      }
      onDrop={isDraggable && onDrop ? () => onDrop(idx) : undefined}
      onDragEnd={isDraggable ? onDragEnd : undefined}
      className="group flex w-full items-center gap-1.5 py-1 cursor-pointer text-left relative"
      style={{
        borderLeft: `3px solid ${borderColor ?? "transparent"}`,
        paddingLeft: `${paddingLeft}px`,
        paddingRight: "12px",
        background: isActive
          ? page.border
          : isVisible
            ? `${page.border}80`
            : "transparent",
        ...(isDropTarget && {
          boxShadow: `inset 0 2px 0 ${page.fg}`,
        }),
      }}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
    >
      {/* Clickable left border zone for expand/collapse */}
      {onBorderClick && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: border toggle zone
        // biome-ignore lint/a11y/noStaticElementInteractions: border toggle zone
        <div
          className="absolute inset-y-0 left-0 cursor-pointer"
          style={{ width: `${paddingLeft + 3}px` }}
          onClick={(e) => {
            e.stopPropagation();
            onBorderClick();
          }}
        />
      )}
      <AgentStatusIcon
        status={(agentState?.status as AgentStatus) ?? "working"}
        size={14}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="flex-1 truncate text-xs">{s.name}</span>
          <span
            className="shrink-0 text-[10px]"
            style={{ color: page.statusFg }}
          >
            {notifCount > 0 && (
              <span style={{ color: "#ea6c73" }}>{notifCount} unread · </span>
            )}
            {formatAge(lastActive)}
          </span>
        </div>
        <div
          className="flex items-center text-[10px]"
          style={{ color: page.statusFg }}
        >
          <span className="flex-1 min-w-0 truncate">
            {meta?.projectName ?? s.workingDirectory.split("/").pop()}
            {meta?.gitBranch &&
              meta.gitBranch !== "HEAD" &&
              ` · ${meta.gitBranch}`}
          </span>
          {agentState?.status && agentState.status !== "unknown" && (
            <span className="shrink-0 ml-1.5 opacity-75">
              {agentStatusLabel(
                agentState.status as AgentStatus,
                agentState.currentTool,
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ExitedRow({
  session: s,
  page,
  confirmRemoveId,
  onConfirmRemove,
  onRemove,
  indent = 0,
}: {
  session: SessionInfo;
  page: PageTheme;
  confirmRemoveId: string | null;
  onConfirmRemove: (id: string | null) => void;
  onRemove: (id: string) => Promise<void>;
  indent?: number;
}) {
  const paddingLeft = 9 + indent * 16;
  return (
    <div
      className="group flex w-full items-center gap-1.5 py-1 text-left"
      style={{
        borderLeft: "3px solid transparent",
        paddingLeft: `${paddingLeft}px`,
        paddingRight: "12px",
        opacity: 0.5,
      }}
    >
      <AgentStatusIcon status="stopped" size={14} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="flex-1 truncate text-xs">{s.name}</span>
          <span
            className="shrink-0 text-[10px]"
            style={{ color: page.statusFg }}
          >
            stopped
          </span>
        </div>
      </div>
      {confirmRemoveId === s.id ? (
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={async () => {
              try {
                await onRemove(s.id);
                onConfirmRemove(null);
              } catch {
                // Keep confirm visible on failure
              }
            }}
            className="text-[10px] px-1 rounded cursor-pointer"
            style={{ color: "#ea6c73" }}
            title="Confirm permanent removal"
          >
            remove
          </button>
          <button
            type="button"
            onClick={() => onConfirmRemove(null)}
            className="text-[10px] px-1 rounded cursor-pointer"
            style={{ color: page.statusFg }}
            title="Cancel"
          >
            cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onConfirmRemove(s.id)}
          className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
          style={{ color: page.statusFg }}
          title="Remove permanently"
        >
          <Codicon name="trash" size={12} />
        </button>
      )}
    </div>
  );
}

// ── Hierarchy tree node ─────────────────────────────────────────────────

interface HierarchyNodeRowProps {
  node: SidebarHierarchyNode;
  depth: number;
  /** Key identifying this node's group (parent name, or "__root__") */
  groupKey: string;
  /** Index of this node within its sibling group */
  indexInGroup: number;
  page: PageTheme;
  isPaneActive: (pane: ActivePane) => boolean;
  visiblePaneIds: Set<string>;
  sessionMetaMap: Map<
    string,
    {
      summary?: string;
      projectName?: string;
      gitBranch?: string;
      lastModified: number;
      gitDiffStat?: { insertions: number; deletions: number };
    }
  >;
  agentStatuses: Record<
    string,
    { status: string; currentTool?: string; toolDetail?: string }
  >;
  notificationCounts: Record<string, number>;
  collapsedGroups: Set<string>;
  toggleCollapsed: (name: string) => void;
  switchPane: (pane: ActivePane | null) => void;
  markNotificationsRead: (sessionId: string) => Promise<void>;
  onReorder: (groupKey: string, fromIndex: number, toIndex: number) => void;
  /** Shared drag state across all hierarchy rows */
  hierDrag: React.MutableRefObject<{ group: string; idx: number } | null>;
  hierDropTarget: { group: string; idx: number } | null;
  setHierDropTarget: (v: { group: string; idx: number } | null) => void;
}

function HierarchyNodeRow({
  node,
  depth,
  groupKey,
  indexInGroup,
  page,
  isPaneActive,
  visiblePaneIds,
  sessionMetaMap,
  agentStatuses,
  notificationCounts,
  collapsedGroups,
  toggleCollapsed,
  switchPane,
  markNotificationsRead,
  onReorder,
  hierDrag,
  hierDropTarget,
  setHierDropTarget,
}: HierarchyNodeRowProps) {
  const s = node.session; // may be undefined for exited agents
  const isCollapsed = collapsedGroups.has(node.org.name.toLowerCase());
  const hasChildren = node.children.length > 0;

  const isDropTarget =
    hierDropTarget?.group === groupKey && hierDropTarget?.idx === indexInGroup;

  // Colored left border for parents only
  const borderColor = hasChildren
    ? isCollapsed
      ? "rgba(255,255,255,0.15)"
      : "rgba(59,130,246,0.5)"
    : undefined;

  return (
    <>
      {s ? (
        <SessionRow
          session={s}
          pane={{ type: "session", id: s.id }}
          idx={indexInGroup}
          page={page}
          isActive={isPaneActive({ type: "session", id: s.id })}
          isVisible={visiblePaneIds.has(s.id)}
          isDropTarget={isDropTarget}
          meta={
            s.claudeSessionId
              ? sessionMetaMap.get(s.claudeSessionId)
              : undefined
          }
          agentState={agentStatuses[s.id]}
          notifCount={notificationCounts[s.id] ?? 0}
          indent={depth}
          borderColor={borderColor}
          onBorderClick={
            hasChildren
              ? () => toggleCollapsed(node.org.name.toLowerCase())
              : undefined
          }
          draggable
          onDragStart={(e, _idx, _pane) => {
            hierDrag.current = { group: groupKey, idx: indexInGroup };
            // Do NOT call startDrag() — it activates the layout DropZoneOverlay
            // which crashes when trying to split/move panes. Hierarchy drag is
            // sidebar-only reordering.
            e.dataTransfer.setData("text/plain", "");
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(e) => {
            if (hierDrag.current?.group === groupKey) {
              e.preventDefault();
              setHierDropTarget({ group: groupKey, idx: indexInGroup });
            }
          }}
          onDrop={() => {
            if (
              hierDrag.current &&
              hierDrag.current.group === groupKey &&
              hierDrag.current.idx !== indexInGroup
            ) {
              onReorder(groupKey, hierDrag.current.idx, indexInGroup);
            }
            hierDrag.current = null;
            setHierDropTarget(null);
          }}
          onDragEnd={() => {
            hierDrag.current = null;
            setHierDropTarget(null);
          }}
          onClick={() => {
            const pane: ActivePane = { type: "session", id: s.id };
            switchPane(pane);
            focusTerminal(pane.id);
            if (notificationCounts[s.id]) markNotificationsRead(s.id);
          }}
        />
      ) : (
        /* Exited / no live session — dimmed label */
        // biome-ignore lint/a11y/useKeyWithClickEvents: non-critical stopped row
        // biome-ignore lint/a11y/noStaticElementInteractions: non-critical stopped row
        <div
          className={`flex items-center gap-1.5 py-1${hasChildren ? " cursor-pointer" : ""}`}
          style={{
            borderLeft: `3px solid ${borderColor ?? "transparent"}`,
            paddingLeft: `${9 + depth * 10}px`,
            paddingRight: "12px",
            opacity: 0.4,
          }}
          onClick={
            hasChildren
              ? () => toggleCollapsed(node.org.name.toLowerCase())
              : undefined
          }
        >
          <AgentStatusIcon status="stopped" size={14} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1">
              <span className="flex-1 truncate text-xs">{node.org.name}</span>
              <span
                className="shrink-0 text-[10px]"
                style={{ color: page.statusFg }}
              >
                stopped
              </span>
            </div>
            {node.org.template && (
              <div className="text-[10px]" style={{ color: page.statusFg }}>
                {node.org.template}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Children (if expanded) */}
      {hasChildren &&
        !isCollapsed &&
        node.children.map((child, idx) => (
          <HierarchyNodeRow
            key={child.org.name}
            node={child}
            depth={depth + 1}
            groupKey={node.org.name.toLowerCase()}
            indexInGroup={idx}
            page={page}
            isPaneActive={isPaneActive}
            visiblePaneIds={visiblePaneIds}
            sessionMetaMap={sessionMetaMap}
            agentStatuses={agentStatuses}
            notificationCounts={notificationCounts}
            collapsedGroups={collapsedGroups}
            toggleCollapsed={toggleCollapsed}
            switchPane={switchPane}
            markNotificationsRead={markNotificationsRead}
            onReorder={onReorder}
            hierDrag={hierDrag}
            hierDropTarget={hierDropTarget}
            setHierDropTarget={setHierDropTarget}
          />
        ))}
    </>
  );
}

// ── Project item ────────────────────────────────────────────────────────

interface ProjectItemProps {
  project: ProjectInfo;
  page: PageTheme;
  liveSessionIds: Set<string>;
}

const ProjectItem = React.memo(function ProjectItem({
  project,
  page,
  liveSessionIds,
}: ProjectItemProps) {
  const resumeSession = useStore((s) => s.resumeSession);
  const createSession = useStore((s) => s.createSession);
  const status = useStore((s) => s.status);
  const isBusy = status === "resuming..." || status === "spawning...";

  const [expanded, setExpanded] = useState(false);

  return (
    <div>
      <div className="group flex items-center">
        <button
          type="button"
          className="flex flex-1 items-center gap-2 px-3 py-1.5 cursor-pointer text-left min-w-0"
          onClick={() => setExpanded(!expanded)}
        >
          <span
            className="text-[10px] shrink-0"
            style={{ color: page.statusFg }}
          >
            {expanded ? "▼" : "▶"}
          </span>
          <span className="flex-1 truncate text-xs font-medium">
            {project.name}
          </span>
          <span
            className="shrink-0 text-[10px]"
            style={{ color: page.statusFg }}
          >
            {project.sessions.length}
          </span>
        </button>
        <button
          type="button"
          disabled={isBusy}
          className="shrink-0 rounded px-1.5 mr-2 text-xs opacity-0 transition-opacity group-hover:opacity-100 cursor-pointer disabled:opacity-50"
          style={{ color: "#238636" }}
          title={`New session in ${project.name}`}
          onClick={() => createSession(project.path)}
        >
          +
        </button>
      </div>

      {expanded && (
        <div className="pl-4">
          {project.sessions.map((s) => {
            const isLive = liveSessionIds.has(s.sessionId);
            const isExited = s.autonomosStatus === "exited" && !isLive;

            let dotColor = "transparent";
            let tooltip = "Resume this session";
            if (isLive) {
              dotColor = "#238636";
              tooltip = "Switch to live session";
            } else if (isExited) {
              dotColor = "#848d97";
              tooltip = "Resume autonomOS agent with full config";
            }

            return (
              <button
                type="button"
                key={s.sessionId}
                disabled={isBusy}
                className="flex w-full items-start gap-2 px-3 py-1.5 text-xs text-left cursor-pointer hover:opacity-80 disabled:opacity-50"
                style={{
                  color: page.fg,
                  opacity: isExited ? 0.6 : 1,
                }}
                onClick={() =>
                  resumeSession(s.sessionId, project.path, s.summary, {
                    isAutonomosAgent: s.isAutonomosAgent,
                  })
                }
                title={tooltip}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full mt-1"
                  style={{ background: dotColor }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1">
                    <p className="truncate flex-1">{s.summary}</p>
                    {isExited && (
                      <span
                        className="shrink-0 text-[10px]"
                        title={`autonomOS agent${s.template ? ` (${s.template})` : ""}`}
                      >
                        stopped
                      </span>
                    )}
                  </div>
                  <div
                    className="flex items-center gap-2 mt-0.5"
                    style={{ color: page.statusFg }}
                  >
                    {s.isAutonomosAgent && (
                      <span className="text-[10px]">
                        {s.template ?? "agent"}
                      </span>
                    )}
                    {s.gitBranch && (
                      <span className="text-[10px] truncate max-w-[120px]">
                        {s.gitBranch}
                      </span>
                    )}
                    <span className="text-[10px]">
                      {formatAge(s.lastModified)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
