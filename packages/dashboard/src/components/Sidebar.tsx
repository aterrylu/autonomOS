import React, { useEffect, useMemo, useRef, useState } from "react";
import type { ActivePane, ProjectInfo } from "../store";
import { buildSidebarItems, sidebarItemPane, THEMES, useStore } from "../store";
import { Codicon } from "./Codicon";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

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
  const theme = useStore((s) => s.theme);
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const activePane = useStore((s) => s.activePane);
  const paneOrder = useStore((s) => s.paneOrder);
  const previewPanes = useStore((s) => s.previewPanes);
  const fetchSessions = useStore((s) => s.fetchSessions);
  const fetchProjects = useStore((s) => s.fetchProjects);
  const createSession = useStore((s) => s.createSession);
  const switchPane = useStore((s) => s.switchPane);
  const closePreview = useStore((s) => s.closePreview);
  const reorderPanes = useStore((s) => s.reorderPanes);
  const status = useStore((s) => s.status);
  const page = THEMES[theme].page;

  const isSpawning = status === "spawning...";

  const sidebarItems = useMemo(
    () => buildSidebarItems(sessions, previewPanes, paneOrder),
    [sessions, previewPanes, paneOrder],
  );

  // Build a lookup map from claudeSessionId → enriched project session data.
  const sessionMetaMap = useMemo(() => {
    const map = new Map<
      string,
      {
        summary?: string;
        gitBranch?: string;
        lastModified: number;
        gitDiffStat?: { insertions: number; deletions: number };
      }
    >();
    for (const p of projects) {
      for (const ps of p.sessions) {
        map.set(ps.sessionId, {
          summary: ps.summary,
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

  // Poll live sessions every 5s, projects every 30s (heavier operation)
  useEffect(() => {
    fetchSessions();
    fetchProjects();
    const sessionsInterval = setInterval(fetchSessions, 5000);
    const projectsInterval = setInterval(fetchProjects, 30000);
    return () => {
      clearInterval(sessionsInterval);
      clearInterval(projectsInterval);
    };
  }, [fetchSessions, fetchProjects]);

  // Drag state
  const dragIdx = useRef<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  function handleDragStart(idx: number) {
    dragIdx.current = idx;
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
      {/* Live Sessions Section */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <span
          className="text-xs font-medium uppercase"
          style={{ color: page.statusFg }}
        >
          Live Sessions
        </span>
        <button
          type="button"
          onClick={() => createSession()}
          disabled={isSpawning}
          className="rounded px-2 py-0.5 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "#238636", color: "#fff" }}
          title="New Session"
        >
          +
        </button>
      </div>

      <div className="py-1">
        {sidebarItems.length === 0 && (
          <p
            className="px-3 py-3 text-center text-xs"
            style={{ color: page.statusFg }}
          >
            No active sessions
          </p>
        )}

        {sidebarItems.map((item, idx) => {
          const pane = sidebarItemPane(item);
          const isActive = isPaneActive(pane);
          const isDropTarget = dropIdx === idx;

          if (item.type === "session") {
            const s = item.data;
            const meta = s.claudeSessionId
              ? sessionMetaMap.get(s.claudeSessionId)
              : undefined;
            const displayName = meta?.summary || s.name;
            const lastActive = meta?.lastModified ?? s.createdAt;

            return (
              // biome-ignore lint/a11y/useSemanticElements: nested interactive elements
              <div
                key={`s-${s.id}`}
                role="button"
                tabIndex={0}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDrop={() => handleDrop(idx)}
                onDragEnd={handleDragEnd}
                className="group flex w-full items-center gap-1.5 px-3 py-1 cursor-pointer text-left"
                style={{
                  background: isActive ? page.border : "transparent",
                  ...(isDropTarget && {
                    boxShadow: `inset 0 2px 0 ${page.fg}`,
                  }),
                }}
                onClick={() => switchPane(pane)}
                onKeyDown={(e) => e.key === "Enter" && switchPane(pane)}
              >
                <Codicon name="claude" size={12} />
                <div className="flex-1 min-w-0">
                  {/* Top row: title + git stats */}
                  <div className="flex items-center gap-1">
                    <span className="flex-1 truncate text-xs">
                      {displayName}
                    </span>
                    {meta?.gitBranch && meta?.gitDiffStat && (
                      <DiffStat stat={meta.gitDiffStat} />
                    )}
                  </div>
                  {/* Bottom row: branch + time */}
                  <div
                    className="flex items-center gap-2 text-[10px]"
                    style={{ color: page.statusFg }}
                  >
                    {meta?.gitBranch && meta.gitBranch !== "HEAD" && (
                      <span className="truncate max-w-[120px]">
                        {meta.gitBranch}
                      </span>
                    )}
                    <span className="ml-auto shrink-0">
                      {formatAge(lastActive)}
                    </span>
                  </div>
                </div>
              </div>
            );
          }

          // Preview pane row
          const p = item.data;
          return (
            // biome-ignore lint/a11y/useSemanticElements: nested interactive elements
            <div
              key={`p-${p.id}`}
              role="button"
              tabIndex={0}
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDrop={() => handleDrop(idx)}
              onDragEnd={handleDragEnd}
              className="group flex w-full items-center gap-1.5 px-3 py-1 cursor-pointer text-left"
              style={{
                background: isActive ? page.border : "transparent",
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
            activePane={activePane}
            sessions={sessions}
          />
        ))}
      </div>
    </aside>
  );
}

interface ProjectItemProps {
  project: ProjectInfo;
  page: PageTheme;
  liveSessionIds: Set<string>;
  activePane: ActivePane | null;
  sessions: { id: string; claudeSessionId?: string }[];
}

const ProjectItem = React.memo(function ProjectItem({
  project,
  page,
  liveSessionIds,
  activePane,
  sessions,
}: ProjectItemProps) {
  const resumeSession = useStore((s) => s.resumeSession);
  const createSession = useStore((s) => s.createSession);
  const status = useStore((s) => s.status);
  const isBusy = status === "resuming..." || status === "spawning...";

  // Derive the active Claude session ID from the active pane
  const activeClaude = useMemo(() => {
    if (activePane?.type !== "session") return undefined;
    return sessions.find((s) => s.id === activePane.id)?.claudeSessionId;
  }, [activePane, sessions]);

  const hasActiveSession =
    activeClaude != null &&
    project.sessions.some((ps) => ps.sessionId === activeClaude);
  const [expanded, setExpanded] = useState(hasActiveSession);

  useEffect(() => {
    if (hasActiveSession) setExpanded(true);
  }, [hasActiveSession]);

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
            return (
              <button
                type="button"
                key={s.sessionId}
                disabled={isBusy}
                className="flex w-full items-start gap-2 px-3 py-1.5 text-xs text-left cursor-pointer hover:opacity-80 disabled:opacity-50"
                style={{ color: page.fg }}
                onClick={() =>
                  resumeSession(s.sessionId, project.path, s.summary)
                }
                title={
                  isLive ? "Switch to live session" : "Resume this session"
                }
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full mt-1"
                  style={{
                    background: isLive ? "#238636" : "transparent",
                  }}
                />
                <div className="flex-1 min-w-0">
                  <p className="truncate">{s.summary}</p>
                  <div
                    className="flex items-center gap-2 mt-0.5"
                    style={{ color: page.statusFg }}
                  >
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
