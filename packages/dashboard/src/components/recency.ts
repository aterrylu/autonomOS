// Recency treatment for the sidebar's last-activity timestamp (recency B2 —
// timestamp-only fade; see docs/DECISIONS.md). The ONLY thing that changes is the
// top-right "41m"/"11d" timestamp; the row, name, status icon, and repo·branch
// line are untouched.
//
// The intent is de-emphasis, not alarm: a fresh (<1h) row's timestamp reads at
// full text brightness (the theme's foreground), then older rows keep the neutral
// status gray and fade by opacity so wildly-stale sessions recede. Anchoring fresh
// at the bright foreground is what gives the four buckets enough brightness range
// to stay visibly distinct (fresh > recent > stale > ancient) while still legible.
// The lower three buckets align with formatAge()'s own unit boundaries
// (<1h → "Xm", <24h → "Xh", ≥24h → "Xd"); the stale→ancient step at 7d is a
// recency threshold, not a unit change (both render "Xd").
//
// Buckets are computed from the same `lastActive` the timestamp text already
// renders from, on the same render pass — so the bucket re-evaluates on the
// sidebar's existing ~5s poll cadence. No new timer.

export type RecencyBucket = "fresh" | "recent" | "stale" | "ancient";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

// Opacity is applied to the age TEXT only (Sidebar.tsx wraps just formatAge in
// the faded span); the unread-count prefix stays full-strength as an attention
// signal, like the status dot and label.
//
// The fade is THEME-AWARE, because opacity composites toward the background:
// on a dark theme "fainter" fades toward black (contrast preserved), but on a
// light theme it fades toward white (contrast collapses fast, since statusFg is
// already low-contrast on a near-white page). So dark themes take a deep ramp and
// light themes a shallower one, chosen so 11d/34d stay legible on white.
export const RECENCY_OPACITY_DARK: Record<RecencyBucket, number> = {
  fresh: 1,
  recent: 1,
  stale: 0.72,
  ancient: 0.52,
};
export const RECENCY_OPACITY_LIGHT: Record<RecencyBucket, number> = {
  fresh: 1,
  recent: 1,
  stale: 0.86,
  ancient: 0.74,
};

/**
 * Whether a `#rrggbb` background reads as "light" (Rec. 601 luma > 0.5). Drives
 * ramp selection so any theme — including a future one — is classified by its own
 * background rather than a hardcoded name. An unparseable value falls back to the
 * dark ramp (the deeper fade is the more common, dark-first case).
 */
export function isLightBg(bg: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg.trim());
  if (!m) return false;
  const r = Number.parseInt(m[1], 16);
  const g = Number.parseInt(m[2], 16);
  const b = Number.parseInt(m[3], 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

/**
 * Classify an age (ms since last activity) into a recency bucket.
 * Non-finite or negative ages (missing/skewed timestamps, which formatAge renders
 * as "unknown"/"now") fall back to `recent` — full opacity, neutral color — so an
 * unknown age is never faded into near-invisibility.
 */
export function recencyBucket(ageMs: number): RecencyBucket {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "recent";
  if (ageMs < HOUR_MS) return "fresh";
  if (ageMs < DAY_MS) return "recent";
  if (ageMs < WEEK_MS) return "stale";
  return "ancient";
}

/**
 * Resolve the inline style for the timestamp span from a `lastActive` timestamp
 * (ms epoch) and `now`, plus three theme tokens: the neutral `statusFg`, the
 * `freshColor` (the theme's foreground / text color), and `bg` (the page
 * background, used only to pick the light- vs dark-theme opacity ramp). Fresh
 * renders in `freshColor`; every other bucket keeps `statusFg` and only varies
 * opacity. All colors are supplied by the caller so this stays a pure
 * timestamp → style mapper with no palette of its own — and because `freshColor`
 * is the theme's own text color, fresh is guaranteed legible on every theme with
 * no per-theme tuning.
 *
 * The timestamp is guarded on the SAME terms as formatAge() (Sidebar.tsx): a
 * non-finite or non-positive `lastActive` is "unknown", not ancient. Guarding the
 * timestamp here (not the derived age) is load-bearing — `now - 0` is a huge
 * POSITIVE age that would otherwise bucket as "ancient" and fade the "unknown"
 * label to near-invisibility, the exact failure this feature exists to avoid. A
 * degenerate timestamp yields NaN → recencyBucket → `recent` → full opacity, so
 * the fade and formatAge always agree on what "unknown" means.
 */
export function recencyTimestampStyle(
  lastActive: number,
  now: number,
  statusFg: string,
  freshColor: string,
  bg: string,
): { color: string; opacity: number } {
  const ageMs =
    Number.isFinite(lastActive) && lastActive > 0
      ? now - lastActive
      : Number.NaN;
  const bucket = recencyBucket(ageMs);
  const ramp = isLightBg(bg) ? RECENCY_OPACITY_LIGHT : RECENCY_OPACITY_DARK;
  return {
    color: bucket === "fresh" ? freshColor : statusFg,
    opacity: ramp[bucket],
  };
}
