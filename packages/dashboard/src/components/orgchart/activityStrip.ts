import type { OrgChartTokens } from "./theme";

/**
 * The 24-hour activity strip's geometry and colors — ONE definition shared by
 * the inspector's strip and the card's thin strip, so they can't disagree.
 */

const DAY_MS = 86_400_000;

const WORKING_STATUSES = new Set([
  "working",
  "tool_running",
  "orchestrating",
  "compacting",
]);

/** Color for a status segment on the strip. */
export function segmentColor(status: string, tokens: OrgChartTokens): string {
  if (status === "needs_input") return tokens.status.needsInput;
  if (status === "error") return tokens.status.error;
  if (WORKING_STATUSES.has(status)) return tokens.status.active;
  if (status === "idle" || status === "ready")
    return `${tokens.status.ready}80`;
  return tokens.cardBorder; // stopped / unknown
}

export interface StripSegment {
  status: string;
  from: number;
  to: number;
  /** Position and size in percent of the strip. */
  left: number;
  width: number;
}

/**
 * Lay a status history out on a strip ending at `now`. It spans from the first
 * recorded change, at most 24h back and at least a minute — a young agent's few
 * minutes would otherwise be a hairline. The last segment runs to the CLIENT's
 * `now` (the data ends at the server's clock when it was fetched), so the right
 * edge never shows an empty band between refreshes.
 */
export function stripLayout(
  activity: Array<{ from: number; to: number; status: string }>,
  now: number,
): { start: number; span: number; segments: StripSegment[] } {
  const first = activity[0]?.from ?? now;
  const start = Math.max(now - DAY_MS, Math.min(first, now - 60_000));
  const span = now - start;
  const segments = activity.map((seg, i) => {
    const to = i === activity.length - 1 ? Math.max(seg.to, now) : seg.to;
    const from = Math.max(seg.from, start);
    return {
      status: seg.status,
      from: seg.from,
      to,
      left: ((from - start) / span) * 100,
      width: (Math.max(0, to - from) / span) * 100,
    };
  });
  return { start, span, segments };
}
