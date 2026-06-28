import { memo, useRef } from "react";
import { useTerminal } from "../hooks/useTerminal";
import { CopyToast } from "./CopyToast";
import { UsageQueueButton } from "./UsageQueueButton";

interface SessionPaneProps {
  sessionId: string;
  visible: boolean;
}

/**
 * A single session's view container. Renders a terminal.
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
      className="relative flex-1 min-w-0 min-h-0 overflow-hidden"
      style={{ display: visible ? "flex" : "none" }}
    >
      <div
        ref={containerRef}
        className="flex-1 p-1 min-w-0 min-h-0"
        style={{ touchAction: "none" }}
      />
      <CopyToast toast={copyToast} />
      <UsageQueueButton sessionId={sessionId} />
    </div>
  );
});
