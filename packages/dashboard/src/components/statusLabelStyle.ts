import type { AgentStatus } from "./ui/agent-status-icon";

// Muted-accent coloring for the sidebar's bottom-line status LABEL (the
// agentStatusLabel text). Labels only — the status DOTS keep their existing
// bright colors. See docs/DECISIONS.md.
//
// Active-work statuses (working / tool_running / compacting / orchestrating)
// render with an animated slate-blue shimmer so an actively-working agent reads
// as BUSY at a glance — the motion is the signal, not a loud hue. Every other
// status takes a static, muted color (calm; the palette is deliberately
// desaturated). needs_input is amber — the one attention color. No status uses
// gold (reserved: preset pill / active ring / cursor).
//
// THEME-AWARE: the palette is chosen by the page background (isLightBg). The dark
// palette is the approved muted set; on a light theme those mid-tones collapse to
// ~2:1 contrast on near-white, so light themes get darkened variants of the same
// hues. Fresh mirrors how the recency feature (ADR-088) went theme-aware for the
// same reason. The shimmer itself is a CSS class (`.status-shimmer` /
// `.status-shimmer-light` in index.css) because keyframes can't be inlined; all
// active rows share one animation so they sweep in sync, and each class carries a
// reduced-motion + `@supports` fallback to its own visible base color.

const ACTIVE_WORK = new Set<AgentStatus>([
  "working",
  "tool_running",
  "compacting",
  "orchestrating",
]);

/** Muted palette approved on the dark themes (void/midnight). */
export const STATUS_COLORS_DARK = {
  active: "#7e97b3", // slate-blue (shimmer base + fallback)
  ready: "#7d9a80", // muted sage (ready / idle)
  needsInput: "#eab308", // amber (attention)
  error: "#d98a6a", // muted red
  neutral: "#a3a3a3", // gray (stopped / unknown / other)
} as const;

/** Darkened variants for light themes — same hues, legible on a near-white bg. */
export const STATUS_COLORS_LIGHT = {
  active: "#3f5f85", // darker slate-blue (~6.8:1 on #fafaf8)
  ready: "#46714f", // darker sage (~5.6:1)
  needsInput: "#8a6900", // dark amber (~4.7:1) — keeps the "yellow" read, legible
  error: "#b0503a", // darker red (~4.6:1)
  neutral: "#6b7178", // darker gray (~4.5:1)
} as const;

export interface StatusLabelStyle {
  /** The label text color. For a shimmer label this is the base/fallback color;
   *  the animated gradient is applied via the shimmer CSS class instead. */
  color: string;
  /** Active-work → animate the slate-blue shimmer sweep. */
  shimmer: boolean;
}

/**
 * Map an agent status to its label style, using the light or dark palette per
 * `isLight` (from `isLightBg(page.bg)`). Active-work statuses shimmer; every other
 * status gets a static muted-accent color. The switch is exhaustiveness-guarded:
 * a new `AgentActivityStatus` member trips the compiler (`never`) so it can't
 * silently fall through to gray, while runtime version-skew still lands on a
 * visible neutral.
 */
export function statusLabelStyle(
  status: AgentStatus,
  isLight: boolean,
): StatusLabelStyle {
  const p = isLight ? STATUS_COLORS_LIGHT : STATUS_COLORS_DARK;
  if (ACTIVE_WORK.has(status)) {
    return { color: p.active, shimmer: true };
  }
  switch (status) {
    case "ready":
    case "idle":
      return { color: p.ready, shimmer: false };
    case "needs_input":
      return { color: p.needsInput, shimmer: false };
    case "error":
      return { color: p.error, shimmer: false };
    case "stopped":
    case "unknown":
      return { color: p.neutral, shimmer: false };
    // The active-work statuses are handled by ACTIVE_WORK above; list them so the
    // `never` guard sees a total switch.
    case "working":
    case "tool_running":
    case "compacting":
    case "orchestrating":
      return { color: p.active, shimmer: true };
    default: {
      // A new AgentActivityStatus member trips this at compile time; runtime
      // version-skew (server ahead of bundle) still renders visible neutral.
      const _exhaustive: never = status;
      void _exhaustive;
      return { color: p.neutral, shimmer: false };
    }
  }
}
