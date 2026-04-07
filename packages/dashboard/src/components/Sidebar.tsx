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
    })),
  );
}

import { Codicon } from "./Codicon";
import {
  type AgentStatus,
  AgentStatusIcon,
  agentStatusLabel,
} from "./ui/agent-status-icon";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

// ── Display list types ──────────────────────────────────────────────────────

type DisplayItem =
  | { type: "session"; session: SessionInfo; pane: ActivePane }
  | { type: "preview"; preview: PreviewPaneInfo; pane: ActivePane };

function DiffStat({
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
      {/* Agents Section */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <span
          className="text-xs font-medium uppercase"
          style={{ color: page.statusFg }}
        >
          Agents
        </span>
        <button
          type="button"
          onClick={() => createSession()}
          disabled={isSpawning}
          className="rounded px-2 py-0.5 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "#238636", color: "#fff" }}
          title="New Agent"
        >
          +
        </button>
      </div>

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
          // Session row
          if (item.type === "session") {
            const s = item.session;
            const pane = item.pane;
            const isActive = isPaneActive(pane);
            const isDropTarget = dropIdx === idx;
            const meta = s.claudeSessionId
              ? sessionMetaMap.get(s.claudeSessionId)
              : undefined;
            const displayName = s.name;
            const lastActive = meta?.lastModified ?? s.createdAt;
            const agentState = agentStatuses[s.id];

            return (
              // biome-ignore lint/a11y/useSemanticElements: nested interactive elements
              <div
                key={`s-${s.id}`}
                role="button"
                tabIndex={-1}
                onMouseDown={(e: React.MouseEvent) => {
                  // Don't preventDefault — it blocks drag initiation.
                  // focusTerminal() handles stealing focus back after click.
                  // Only prevent for non-draggable elements (group headers).
                  if (!(e.currentTarget as HTMLElement).draggable)
                    e.preventDefault();
                }}
                draggable
                onDragStart={(e) => handleDragStart(e, idx, pane)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                className="group flex w-full items-center gap-1.5 py-1 cursor-pointer text-left"
                style={{
                  borderLeft: "3px solid transparent",
                  paddingLeft: "9px",
                  paddingRight: "12px",
                  background: isActive
                    ? page.border
                    : visiblePaneIds.has(pane.id)
                      ? `${page.border}80`
                      : "transparent",
                  ...(isDropTarget && {
                    boxShadow: `inset 0 2px 0 ${page.fg}`,
                  }),
                }}
                onClick={() => {
                  switchPane(pane);
                  if (pane.type === "session") focusTerminal(pane.id);
                  if (notificationCounts[s.id]) markNotificationsRead(s.id);
                }}
                onKeyDown={(e) => e.key === "Enter" && switchPane(pane)}
              >
                <AgentStatusIcon
                  status={(agentState?.status as AgentStatus) ?? "working"}
                  size={14}
                />
                <div className="flex-1 min-w-0">
                  {/* Top row: title (left), time + unread (right) */}
                  <div className="flex items-center gap-1">
                    <span className="flex-1 truncate text-xs">
                      {displayName}
                    </span>
                    <span
                      className="shrink-0 text-[10px]"
                      style={{ color: page.statusFg }}
                    >
                      {(notificationCounts[s.id] ?? 0) > 0 && (
                        <span style={{ color: "#ea6c73" }}>
                          {notificationCounts[s.id]} unread ·{" "}
                        </span>
                      )}
                      {formatAge(lastActive)}
                    </span>
                  </div>
                  {/* Bottom row: project/branch (left), status (right) */}
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

          // Preview pane row
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

      {/* Org Chart Section */}
      <OrgChartSection page={page} />
    </aside>
  );
}

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
                        exited
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

// ── Org Chart Sidebar Section ─────────────────────────────────────────

function OrgChartSection({ page }: { page: PageTheme }) {
  const viewMode = useStore((s) => s.viewMode);
  const setViewMode = useStore((s) => s.setViewMode);
  const isActive = viewMode === "hierarchy";

  return (
    <>
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
          Org Chart
        </span>
      </div>
      <div className="py-1">
        <button
          type="button"
          onClick={() => setViewMode(isActive ? "terminal" : "hierarchy")}
          className="flex w-full items-center gap-2 px-3 py-1.5 cursor-pointer text-left text-xs"
          style={{
            color: isActive ? page.fg : page.statusFg,
            background: isActive ? page.border : "transparent",
          }}
        >
          <Codicon name="type-hierarchy" size={12} />
          <span>{isActive ? "Close hierarchy view" : "View hierarchy"}</span>
        </button>
      </div>
    </>
  );
}

function formatAge(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
