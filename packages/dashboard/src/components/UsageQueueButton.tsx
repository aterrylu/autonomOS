/**
 * Draggable overlay to queue an auto-press-Enter for when this pane's usage
 * limit next clears.
 *
 * Visibility: it ONLY appears when THIS pane's runtime is at its usage cap — the
 * exact moment it's useful (you've run out and want to line up your next
 * prompt). Showing it always would be noise.
 *
 * Position: DEFAULTS to the pane's top-right so it stays clear of Claude/Codex's
 * bottom input line. Drag it by the left grip handle (or focus the handle and
 * use arrow keys) to move it anywhere in the pane; the position is remembered
 * PER TERMINAL and clamped inside the pane on drag and on pane resize, so it
 * can't be lost off-canvas. See `useDraggableOverlay`.
 *
 * Intent: the label spells out both halves of how it works — it auto-presses
 * Enter at reset, and YOU queue the message by typing it into the terminal
 * yourself (the dashboard can't read the in-progress prompt; it lives in the
 * CLI's input box). The server presses Enter the moment the limit lifts, even
 * with no dashboard open (see server `usageQueue.ts`). Click the pill to cancel.
 */

import { MARGIN, useDraggableOverlay } from "../hooks/useDraggableOverlay";
import { useUsageQueue } from "../hooks/useUsageQueue";
import { timeUntilReset } from "../plugins/claude-usage/utils";

/** Accent colors: yellow = off (armed-able), green = on (armed). */
const GREEN = "#3fb950";
const YELLOW = "#e6b450";
/** Fixed content width so the differing on/off subtitle never resizes it. */
const BAR_WIDTH = 270;
/** Grip-handle column width. */
const HANDLE_WIDTH = 22;

function HourglassIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  );
}

/** Two columns of dots — the conventional "drag me" grip affordance. */
function GripIcon() {
  return (
    <svg
      aria-hidden="true"
      width="12"
      height="16"
      viewBox="0 0 12 16"
      fill="currentColor"
      style={{ flexShrink: 0 }}
    >
      {[3, 8, 13].map((cy) =>
        [3, 9].map((cx) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="1.3" />
        )),
      )}
    </svg>
  );
}

/** A small on/off switch — the state indicator. Grey track + left knob when
 * off; amber track + right knob when on. */
function Switch({ on }: { on: boolean }) {
  return (
    <span
      style={{
        position: "relative",
        width: 34,
        height: 20,
        flexShrink: 0,
        borderRadius: 999,
        background: on ? GREEN : "rgba(130, 130, 140, 0.45)",
        transition: "background 140ms ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 140ms ease",
          boxShadow: "0 1px 2px rgba(0,0,0,0.35)",
        }}
      />
    </span>
  );
}

interface UsageQueueButtonProps {
  sessionId: string;
  /** The pane's agent runtime — the button reads THIS provider's cap, so it
   *  only appears when this agent's own limit is hit (Claude vs Codex), never a
   *  sibling runtime's. Gemini has no cap → never shows. */
  provider: string;
}

export function UsageQueueButton({
  sessionId,
  provider,
}: UsageQueueButtonProps) {
  const { isArmed, capped, resetsAt, capWindow, toggle } = useUsageQueue(
    sessionId,
    provider,
  );
  // Position is per-terminal (keyed by session) and defaults to the pane's
  // top-right, clear of the bottom input line. Hook is called unconditionally
  // (Rules of Hooks) — the early return below is AFTER it.
  const { overlayRef, positionStyle, dragging, handleProps } =
    useDraggableOverlay(`usageQueueOverlayPos:${sessionId}`, {
      top: MARGIN,
      right: MARGIN,
    });

  // Only surfaces when THIS pane's runtime is at its limit — the moment queueing
  // is actually useful, and only for the agent whose usage is actually capped.
  if (!capped) return null;

  const eta = resetsAt ? timeUntilReset(resetsAt) : "";
  const accent = isArmed ? GREEN : YELLOW;
  // Name WHICH limit is capping. The status bar shows only the headline
  // windows (5h/7d), so when a per-model weekly is what hit 90% this label is
  // the user's only clue why the button appeared while the bar reads lower.
  const limitName = capWindow ? `${capWindow} limit` : "usage limit";
  const title = isArmed
    ? `On — will auto-press Enter when your ${limitName} resets${
        eta ? ` (~${eta})` : ""
      }. Click to turn off.`
    : `Off — your ${limitName} is at its cap. Turn on, then type your next prompt into the terminal and it auto-presses Enter when the limit resets.`;

  return (
    <div
      ref={overlayRef}
      data-testid="usage-queue-overlay"
      // Shared floating-overlay "E" family trait (see --overlay-* in index.css):
      // the elevated surface + whisper glow it shares with the Incoming-messages
      // overlay. It KEEPS its own 1.5px accent border — that color encodes the
      // armed/off STATE, so it is deliberately NOT swapped for the neutral
      // hairline. `shadow-lg` dropped; the glow token is the shadow.
      className="absolute z-10 flex items-stretch overflow-hidden rounded-lg"
      style={{
        ...positionStyle,
        width: HANDLE_WIDTH + BAR_WIDTH,
        background: "var(--overlay-surface)",
        boxShadow: "var(--overlay-glow)",
        borderStyle: "solid",
        borderWidth: 1.5,
        borderColor: accent,
        color: "rgb(var(--foreground))",
      }}
    >
      {/* Drag handle — pointer drag + keyboard nudge. A real <button> for
          native focus/keyboard semantics; Enter/Space are harmless no-ops
          (there's no onClick), arrow keys nudge via onKeyDown. */}
      <button
        type="button"
        {...handleProps}
        aria-label="Drag to reposition the auto-Enter control (arrow keys to nudge)"
        title="Drag to move"
        data-testid="usage-queue-drag-handle"
        className="flex items-center justify-center"
        style={{
          width: HANDLE_WIDTH,
          cursor: dragging ? "grabbing" : "grab",
          touchAction: "none",
          border: "none",
          borderRight: "1px solid var(--overlay-divider)",
          background: "transparent",
          color: accent,
          opacity: 0.75,
        }}
      >
        <GripIcon />
      </button>

      {/* Toggle — arm/disarm the auto-Enter. */}
      <button
        type="button"
        role="switch"
        aria-checked={isArmed}
        onClick={toggle}
        title={title}
        aria-label="Auto-Enter when usage limit resets"
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-left transition-colors"
        style={{ background: "transparent", color: "inherit" }}
      >
        <span style={{ color: accent, flexShrink: 0 }}>
          <HourglassIcon />
        </span>
        {/* min-w-0 lets the truncating children shrink instead of widening the bar */}
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-xs font-semibold">
            Auto-Enter when limit resets
          </span>
          <span
            className="truncate text-[11px]"
            style={
              isArmed ? { color: GREEN, fontWeight: 600 } : { opacity: 0.7 }
            }
          >
            {isArmed
              ? eta
                ? `Sends in ~${eta}`
                : "Sends at reset"
              : capWindow
                ? `${capWindow} at limit — type to queue`
                : "Type in the terminal to queue"}
          </span>
        </span>
        <Switch on={isArmed} />
      </button>
    </div>
  );
}
