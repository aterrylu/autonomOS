import { memo, useRef } from "react";
import { focusTerminal, useTerminal } from "../hooks/useTerminal";
import { useStore } from "../store";
import { CopyToast } from "./CopyToast";
import { HandoffOverlay } from "./HandoffOverlay";
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
  const { copyToast, followOff, jumpToLatest } = useTerminal(
    containerRef,
    sessionId,
  );
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
      {followOff && (
        // Viewport is parked in the scrollback (accidental trackpad flick /
        // Shift+PageUp) while output may still be arriving. Rendered whenever
        // the pane is visible — focused or not — so a pane "wandered" into a
        // parked state advertises it before the user clicks in. One click (or
        // just typing: xterm scrollOnUserInput) returns to the live tail.
        <button
          type="button"
          // preventDefault on mousedown: a <button> steals DOM focus on click,
          // so the user's NEXT keystroke would hit the button (Space/Enter
          // re-firing it) instead of the PTY. Suppressing the steal keeps
          // focus where it was; the explicit focusTerminal covers the
          // unfocused-pane click (dockview activates the pane, we focus the
          // xterm textarea so typing resumes immediately).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            jumpToLatest();
            focusTerminal(sessionId);
          }}
          // bottom-12, not bottom-3: UsageQueueButton owns the bottom-right corner
          // (same stacking rule CopyToast documents). Theme tokens, not a fixed
          // palette — the daylight theme is light.
          className="absolute bottom-12 right-3 z-10 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground shadow-lg hover:brightness-110"
        >
          ↓ Jump to latest
        </button>
      )}
      <UsageQueueButton sessionId={sessionId} provider={provider} />
      {/* Hand-off delivery overlay — auto-hides unless this agent has queued
          messages; stacks beneath the usage-queue overlay by default. */}
      <HandoffOverlay sessionId={sessionId} />
    </div>
  );
});
