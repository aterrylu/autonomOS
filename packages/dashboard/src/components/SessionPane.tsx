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
 * The tab bar in PaneSlot handles the session title — no title bar here.
 */
export const SessionPane = memo(function SessionPane({
  sessionId,
  visible,
}: SessionPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { copyToast } = useTerminal(containerRef, sessionId);

  return (
    <div
      className="relative flex-1"
      style={{ display: visible ? "flex" : "none" }}
    >
      <div
        ref={containerRef}
        className="flex-1 p-1"
        style={{ touchAction: "none" }}
      />
      <CopyToast toast={copyToast} />
      <UsageQueueButton sessionId={sessionId} />
    </div>
  );
});
