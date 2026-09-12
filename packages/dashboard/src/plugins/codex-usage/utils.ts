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

/** ChatGPT plan ids whose marketing name isn't derivable from the id. Ported
 *  from codexbar (CodexPlanFormatting.swift): the $200 tier is "Pro 20x", the
 *  $100 tier (`prolite`) is "Pro 5x". Keyed by the id with separators stripped,
 *  so every spelling of one plan (`prolite` / `pro_lite` / `pro-lite`) is one
 *  row here rather than three that can drift apart. */
const PLAN_DISPLAY_NAMES: Record<string, string> = {
  pro: "Pro 20x",
  prolite: "Pro 5x",
};

/** Plan-id words spelled in caps ("k12" → "K12", "gpt" → "GPT"). Mirrors the
 *  server's lane prettifier (limitLabels.ts) so the two never disagree on a
 *  shared token. */
const PLAN_UPPERCASE_WORDS = new Set(["cbp", "gpt", "k12"]);

/**
 * Human plan name for the panel pill. Known ids map to their marketing name;
 * an UNKNOWN id is never hidden — it renders word-split and capitalized
 * ("free_workspace" → "Free Workspace") so a plan OpenAI adds tomorrow still
 * shows something readable. Null when there's no plan at all.
 */
export function formatPlan(plan?: string | null): string | null {
  const raw = plan?.trim();
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[-_\s]+/g, "");
  // Own-property check: a plain-object index would hand back `constructor`
  // (a function) or `__proto__` (an object) for an adversarial plan id.
  if (Object.hasOwn(PLAN_DISPLAY_NAMES, key)) return PLAN_DISPLAY_NAMES[key];
  const words = raw.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return raw;
  // Same joining rule as the server's prettifyLimitName: a version token
  // stays attached to its prefix ("gpt-5" → "GPT-5", not "GPT 5").
  return words
    .map((w) => {
      const lower = w.toLowerCase();
      if (PLAN_UPPERCASE_WORDS.has(lower)) return lower.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .reduce((acc, w, i) =>
      i === 0 ? w : /^\d/.test(w) ? `${acc}-${w}` : `${acc} ${w}`,
    );
}
