import { useEffect, useState } from "react";
import type { ProjectInfo } from "../store";
import { THEMES, useStore } from "../store";

type PageTheme = (typeof THEMES)[keyof typeof THEMES]["page"];

export function Sidebar() {
  const theme = useStore((s) => s.theme);
  const sessions = useStore((s) => s.sessions);
  const projects = useStore((s) => s.projects);
  const sessionId = useStore((s) => s.sessionId);
  const fetchSessions = useStore((s) => s.fetchSessions);
  const fetchProjects = useStore((s) => s.fetchProjects);
  const createSession = useStore((s) => s.createSession);
  const killSession = useStore((s) => s.killSession);
  const switchSession = useStore((s) => s.switchSession);
  const status = useStore((s) => s.status);
  const page = THEMES[theme].page;

  const isSpawning = status === "spawning...";

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
        {sessions.length === 0 && (
          <p
            className="px-3 py-3 text-center text-xs"
            style={{ color: page.statusFg }}
          >
            No active sessions
          </p>
        )}

        {sessions.map((s) => {
          const isActive = s.id === sessionId;
          return (
            // biome-ignore lint/a11y/useSemanticElements: contains nested button for kill action
            <div
              key={s.id}
              role="button"
              tabIndex={0}
              className="group flex w-full items-center gap-2 px-3 py-1.5 cursor-pointer text-left"
              style={{
                background: isActive ? page.border : "transparent",
              }}
              onClick={() => switchSession(s.id)}
              onKeyDown={(e) => e.key === "Enter" && switchSession(s.id)}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background:
                    s.status === "running" ? "#238636" : page.statusFg,
                }}
              />
              <span className="flex-1 truncate text-xs">{s.name}</span>
              <span
                className="shrink-0 text-[10px]"
                style={{ color: page.statusFg }}
              >
                {formatAge(s.createdAt)}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  killSession(s.id);
                }}
                className="shrink-0 rounded px-1 text-xs opacity-0 transition-opacity group-hover:opacity-100 cursor-pointer"
                style={{ color: "#ea6c73" }}
                title="Kill session"
              >
                x
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
          <ProjectItem key={project.path} project={project} page={page} />
        ))}
      </div>
    </aside>
  );
}

interface ProjectItemProps {
  project: ProjectInfo;
  page: PageTheme;
}

function ProjectItem({ project, page }: ProjectItemProps) {
  const resumeSession = useStore((s) => s.resumeSession);
  const createSession = useStore((s) => s.createSession);
  const status = useStore((s) => s.status);
  const sessions = useStore((s) => s.sessions);
  const sessionId = useStore((s) => s.sessionId);
  const isBusy = status === "resuming..." || status === "spawning...";

  // Auto-expand if the active live session belongs to this project
  const activeSession = sessions.find((s) => s.id === sessionId);
  const hasActiveSession =
    activeSession?.claudeSessionId != null &&
    project.sessions.some(
      (ps) => ps.sessionId === activeSession.claudeSessionId,
    );
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
          {project.sessions.map((s) => (
            <button
              type="button"
              key={s.sessionId}
              disabled={isBusy}
              className="flex w-full items-start gap-2 px-3 py-1.5 text-xs text-left cursor-pointer hover:opacity-80 disabled:opacity-50"
              style={{ color: page.fg }}
              onClick={() =>
                resumeSession(s.sessionId, project.path, s.summary)
              }
              title="Resume this session"
            >
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
          ))}
        </div>
      )}
    </div>
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
