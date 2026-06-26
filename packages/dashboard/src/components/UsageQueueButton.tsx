/**
 * Bottom-right pill to queue an auto-press-Enter for when the Claude usage
 * limit next clears.
 *
 * Visibility: it ONLY appears when the account is at the usage cap — the exact
 * moment it's useful (you've run out and want to line up your next prompt).
 * Showing it always would be noise; showing it only here makes it a timely call
 * to action rather than ambient chrome.
 *
 * Intent: the label spells out both halves of how it works — it auto-presses
 * Enter at reset, and YOU queue the message by typing it into the terminal
 * yourself (the dashboard can't read the in-progress prompt; it lives in Claude
 * Code's input box). The server presses Enter the moment the limit lifts, even
 * with no dashboard open (see server `usageQueue.ts`). Click again to cancel.
 */

import { useUsageQueue } from "../hooks/useUsageQueue";
import { timeUntilReset } from "../plugins/claude-usage/utils";

/** Accent colors: yellow = off (armed-able), green = on (armed). */
const GREEN = "#3fb950";
const YELLOW = "#e6b450";
/** Hardcoded bar width so the differing on/off subtitle never resizes it. */
const BAR_WIDTH = 270;

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
}

export function UsageQueueButton({ sessionId }: UsageQueueButtonProps) {
  const { isArmed, capped, resetsAt, toggle } = useUsageQueue(sessionId);

  // Only surfaces at the usage limit — the moment queueing is actually useful.
  if (!capped) return null;

  const eta = resetsAt ? timeUntilReset(resetsAt) : "";
  const accent = isArmed ? GREEN : YELLOW;
  const title = isArmed
    ? `On — will auto-press Enter when your usage limit resets${
        eta ? ` (~${eta})` : ""
      }. Click to turn off.`
    : "Off — turn on, then type your next prompt into the terminal and it auto-presses Enter when your usage limit resets.";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isArmed}
      onClick={toggle}
      title={title}
      aria-label="Auto-Enter when usage limit resets"
      className="absolute right-3 bottom-3 z-10 flex items-center gap-2.5 rounded-lg px-3 py-2 text-left shadow-lg transition-colors"
      style={{
        // Hardcoded width + solid card background. The border signals state
        // (yellow off / green on) at a constant 2px width.
        width: BAR_WIDTH,
        background: "rgb(var(--card))",
        borderStyle: "solid",
        borderWidth: 1.5,
        borderColor: accent,
        color: "rgb(var(--foreground))",
      }}
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
          style={isArmed ? { color: GREEN, fontWeight: 600 } : { opacity: 0.7 }}
        >
          {isArmed
            ? eta
              ? `Sends in ~${eta}`
              : "Sends at reset"
            : "Type in the terminal to queue"}
        </span>
      </span>
      <Switch on={isArmed} />
    </button>
  );
}
