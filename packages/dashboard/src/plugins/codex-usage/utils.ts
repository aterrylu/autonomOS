/**
 * Codex usage helpers. Reuses the generic color/reset/age formatters from the
 * claude-usage plugin (they're pure and provider-neutral) and adds the
 * Codex-specific dynamic window label + title.
 */

export {
  timeAgo,
  timeUntilReset,
  utilizationColor,
} from "../claude-usage/utils";

/**
 * Compact span label for a rate-limit window derived from its length in minutes.
 * Codex window lengths are plan-dependent (free plan reports a 30-day primary;
 * paid plans a 5h secondary + 7d weekly primary), so we label DYNAMICALLY from
 * the reported length rather than hardcoding "5h"/"7d".
 *   300 → "5h", 1440 → "1d", 10080 → "7d", 43200 → "30d", 90 → "90m".
 */
export function windowLabel(windowMinutes: number): string {
  if (!windowMinutes || windowMinutes <= 0) return "";
  if (windowMinutes % 1440 === 0) return `${windowMinutes / 1440}d`;
  if (windowMinutes % 60 === 0) return `${windowMinutes / 60}h`;
  return `${windowMinutes}m`;
}

/**
 * Human title for a window derived from its length — NOT from which field
 * (primary/secondary) carried it. This keeps the label honest across plans: a
 * free plan's 30-day window reads "Monthly", a paid plan's 5h/7d windows read
 * "Session"/"Weekly". Deriving from the data (not the field name) also makes us
 * immune to any primary/secondary field-semantics differences between plans.
 */
export function windowTitle(windowMinutes: number): string {
  if (!windowMinutes || windowMinutes <= 0) return "Usage";
  if (windowMinutes <= 360) return "Session"; // ~5h rolling window
  if (windowMinutes < 10080) return "Daily";
  if (windowMinutes < 43200) return "Weekly"; // 7d
  return "Monthly"; // 30d+
}
