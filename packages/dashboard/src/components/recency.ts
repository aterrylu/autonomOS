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

// Opacity per bucket ("Balanced wide" ramp). Applied to the whole timestamp span
// (including any unread prefix) so an old row's timestamp genuinely recedes. Fresh
// and recent are full; stale and ancient fade far enough apart to read as distinct
// steps without either becoming illegible.
export const RECENCY_OPACITY: Record<RecencyBucket, number> = {
  fresh: 1,
  recent: 1,
  stale: 0.72,
  ancient: 0.52,
};

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
 * (ms epoch) and `now`, plus two theme tokens: the neutral `statusFg` and
 * `freshColor` (the theme's foreground / text color). Fresh renders in
 * `freshColor`; every other bucket keeps `statusFg` and only varies opacity. Both
 * colors are supplied by the caller so this stays a pure timestamp → style mapper
 * with no palette of its own — and because `freshColor` is the theme's own text
 * color, fresh is guaranteed legible on every theme with no per-theme tuning.
 * Opacity (rather than a pre-blended color) carries the fade on purpose: it
 * recedes toward whatever is behind the text — page background OR an active-row
 * highlight — and adapts across themes without per-theme color math.
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
): { color: string; opacity: number } {
  const ageMs =
    Number.isFinite(lastActive) && lastActive > 0
      ? now - lastActive
      : Number.NaN;
  const bucket = recencyBucket(ageMs);
  return {
    color: bucket === "fresh" ? freshColor : statusFg,
    opacity: RECENCY_OPACITY[bucket],
  };
}
