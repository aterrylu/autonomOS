import { useRef } from "react";
import { useTerminal } from "../hooks/useTerminal";

interface SessionPaneProps {
  sessionId: string;
  visible: boolean;
}

/**
 * A single session's view container. Currently renders a terminal.
 * In the future, sessions may have additional views (VNC, camera, etc.)
 * alongside the terminal — this component is the mount point for all of them.
 */
export function SessionPane({ sessionId, visible }: SessionPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  useTerminal(containerRef, sessionId);

  return (
    <div
      ref={containerRef}
      className="flex-1 p-1"
      style={{ display: visible ? "flex" : "none" }}
    />
  );
}
