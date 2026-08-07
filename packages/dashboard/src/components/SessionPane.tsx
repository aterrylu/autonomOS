import { memo, useRef } from "react";
import { useTerminal } from "../hooks/useTerminal";
import { useStore } from "../store";
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
  // This pane's agent runtime — gates the usage-queue button to THIS provider's
  // cap (ADR-068). "" when not found → the button stays hidden.
  const provider = useStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.provider ?? "",
  );

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
      <UsageQueueButton sessionId={sessionId} provider={provider} />
    </div>
  );
});
