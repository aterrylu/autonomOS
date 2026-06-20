/**
 * Bottom-right overlay button to queue an auto-send for when the Claude usage
 * limit next clears.
 *
 * Type your next prompt into Claude Code's input box (it sits there unsent
 * while you're capped), then click this to arm the pane. The server watches
 * usage and presses Enter the moment the limit lifts — even with no dashboard
 * open (see server `usageQueue.ts`). Click again to cancel.
 *
 * Positioned like {@link ./CopyToast} (the toast is nudged above it). Disarmed
 * it's a faint, unobtrusive glyph; armed it lights up amber — the same hue the
 * usage plugin uses for a near-cap window — and shows a reset ETA when known.
 */

import { useUsageQueue } from "../hooks/useUsageQueue";
import { timeUntilReset } from "../plugins/claude-usage/utils";

/** Amber accent — matches `utilizationColor`'s near-cap hue. */
const ARMED_COLOR = "#e6b450";

function HourglassIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </svg>
  );
}

interface UsageQueueButtonProps {
  sessionId: string;
}

export function UsageQueueButton({ sessionId }: UsageQueueButtonProps) {
  const { isArmed, blocked, resetsAt, toggle } = useUsageQueue(sessionId);

  const eta = isArmed && blocked && resetsAt ? timeUntilReset(resetsAt) : "";

  let title: string;
  if (!isArmed) {
    title =
      "Queue a send: auto-press Enter when the Claude usage limit next clears";
  } else if (blocked) {
    title = `Queued — sends Enter when the usage limit clears${
      eta ? ` (~${eta})` : ""
    }. Click to cancel.`;
  } else {
    title =
      "Queued — sends Enter the next time the usage limit clears. Click to cancel.";
  }

  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      aria-label={title}
      aria-pressed={isArmed}
      className={`absolute right-3 bottom-3 z-10 flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium shadow-lg transition-opacity ${
        isArmed
          ? "opacity-100"
          : "border-border bg-card text-foreground opacity-40 hover:opacity-100"
      }`}
      style={
        isArmed
          ? {
              borderColor: "rgba(230, 180, 80, 0.6)",
              background: "rgba(230, 180, 80, 0.16)",
              color: ARMED_COLOR,
            }
          : undefined
      }
    >
      <HourglassIcon />
      {isArmed && <span>{eta ? `~${eta}` : "queued"}</span>}
    </button>
  );
}
