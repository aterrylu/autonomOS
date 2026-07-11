import { memo, useRef } from "react";
import { useTerminal } from "../hooks/useTerminal";
import { CopyToast } from "./CopyToast";
import { PaneStatusline } from "./PaneStatusline";
import { UsageQueueButton } from "./UsageQueueButton";

interface SessionPaneProps {
  sessionId: string;
  visible: boolean;
}

/**
 * A single session's view container. Renders a terminal with an autonomOS
 * statusline bar beneath it (PaneStatusline gates itself off for Claude panes
 * that already have an in-terminal statusline).
 * The dockview tab (StatusTab) handles the session title — no title bar here.
 */
export const SessionPane = memo(function SessionPane({
  sessionId,
  visible,
}: SessionPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { copyToast } = useTerminal(containerRef, sessionId);

  return (
    <div
      className="flex-1 min-w-0 min-h-0 overflow-hidden"
      style={{ display: visible ? "flex" : "none", flexDirection: "column" }}
    >
      {/* Terminal area — relative so the overlays anchor to it, not the bar. */}
      <div className="relative flex flex-1 min-w-0 min-h-0">
        <div
          ref={containerRef}
          className="flex-1 p-1 min-w-0 min-h-0"
          style={{ touchAction: "none" }}
        />
        <CopyToast toast={copyToast} />
        <UsageQueueButton sessionId={sessionId} />
      </div>
      <PaneStatusline sessionId={sessionId} />
    </div>
  );
});
