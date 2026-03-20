import { memo, useRef } from "react";
import { useTerminal } from "../hooks/useTerminal";
import { THEMES, useStore } from "../store";

interface SessionPaneProps {
  sessionId: string;
  visible: boolean;
}

/**
 * A single session's view container. Currently renders a terminal.
 * In the future, sessions may have additional views (VNC, camera, etc.)
 * alongside the terminal — this component is the mount point for all of them.
 */
export const SessionPane = memo(function SessionPane({
  sessionId,
  visible,
}: SessionPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useTerminal(containerRef, sessionId);

  const session = useStore((s) => s.sessions.find((ss) => ss.id === sessionId));
  const theme = useStore((s) => s.theme);
  const page = THEMES[theme].page;
  const title = session?.name || sessionId.slice(0, 8);

  return (
    <div
      className="relative flex-1"
      style={{ display: visible ? "flex" : "none" }}
    >
      {/* Session title bar */}
      <div
        className="absolute top-0 left-0 right-0 z-10 px-2 py-1 font-medium truncate pointer-events-none select-none"
        style={{
          fontSize: "16px",
          background: page.border,
          color: page.fg,
          borderBottom: `1px solid ${page.bg}`,
        }}
      >
        {title}
      </div>
      <div ref={containerRef} className="flex-1 p-1" />
    </div>
  );
});
