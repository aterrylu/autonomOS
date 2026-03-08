import { useEffect } from "react";
import { THEMES, useStore } from "../store";

export function Sidebar() {
  const theme = useStore((s) => s.theme);
  const sessions = useStore((s) => s.sessions);
  const sessionId = useStore((s) => s.sessionId);
  const fetchSessions = useStore((s) => s.fetchSessions);
  const createSession = useStore((s) => s.createSession);
  const killSession = useStore((s) => s.killSession);
  const switchSession = useStore((s) => s.switchSession);
  const status = useStore((s) => s.status);
  const page = THEMES[theme].page;

  const isSpawning = status === "spawning...";

  // Poll sessions every 5s
  useEffect(() => {
    fetchSessions();
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [fetchSessions]);

  return (
    <aside
      className="flex w-56 shrink-0 flex-col overflow-y-auto"
      style={{ borderRight: `1px solid ${page.border}` }}
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: `1px solid ${page.border}` }}
      >
        <span
          className="text-xs font-medium uppercase"
          style={{ color: page.statusFg }}
        >
          Sessions
        </span>
        <button
          type="button"
          onClick={createSession}
          disabled={isSpawning}
          className="rounded px-2 py-0.5 text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "#238636", color: "#fff" }}
          title="New Session"
        >
          +
        </button>
      </div>

      <div className="flex-1 py-1">
        {sessions.length === 0 && (
          <p
            className="px-3 py-4 text-center text-xs"
            style={{ color: page.statusFg }}
          >
            No active sessions
          </p>
        )}

        {sessions.map((s) => {
          const isActive = s.id === sessionId;
          return (
            <button
              type="button"
              key={s.id}
              className="group flex w-full items-center gap-2 px-3 py-1.5 cursor-pointer text-left"
              style={{
                background: isActive ? page.border : "transparent",
                color: "inherit",
                border: "none",
              }}
              onClick={() => switchSession(s.id)}
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
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function formatAge(createdAt: number): string {
  const seconds = Math.floor((Date.now() - createdAt) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
