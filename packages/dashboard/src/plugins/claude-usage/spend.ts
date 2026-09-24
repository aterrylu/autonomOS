/**
 * Spend display for spend-metered Claude accounts (usage-based Enterprise).
 * Three user-selectable styles for the status-bar item — text (default),
 * percent, bar — plus the shared tooltip text. Pure helpers, no React.
 *
 * Rules (Terry, 2026-09-24):
 *  - Text: gray running total; from 80% of the limit, amber "$930 / $1,000";
 *    at or over the limit, red.
 *  - Percent / bar: no limit ⇒ no denominator ⇒ fall back to the text total,
 *    and the tooltip says why. Never fake a denominator.
 *  - Over the limit: percent shows >100%; the bar is full red with an over
 *    marker.
 *  - Spend is informational. It never drives the usage queue.
 */
import type { SpendDisplay, SpendLimit } from "./types";

/** Amber from here; red at or over the limit. */
export const SPEND_NEAR_PERCENT = 80;

const RED = "#ea6c73";
const AMBER = "#e6b450";
const GREEN = "#238636";

/** Threshold color for a spend percentage (percent / bar styles). */
export function spendColor(percent: number): string {
  if (percent >= 100) return RED;
  if (percent >= SPEND_NEAR_PERCENT) return AMBER;
  return GREEN;
}

/** Currency text: whole units from 10 up ("$620"), cents below ("$4.13").
 *  TRUNCATED, never rounded up: $999.60 must not print as "$1,000" and look
 *  like the limit was reached. */
export function formatMoney(amount: number, currency = "USD"): string {
  const digits = Math.abs(amount) >= 10 ? 0 : 2;
  const factor = 10 ** digits;
  const truncated = Math.trunc(amount * factor) / factor;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(truncated);
  } catch {
    // An unknown currency code must not break the bar.
    return `${truncated.toFixed(digits)} ${currency}`;
  }
}

/** True when a readable limit exists, so a percentage is meaningful. */
export function hasSpendLimit(
  spend: SpendLimit,
): spend is SpendLimit & { limit: number; percent: number } {
  return (
    spend.limitStatus === "set" &&
    spend.limit !== null &&
    spend.percent !== null
  );
}

/**
 * The ONE percentage every rule reads — text, color, the over marker and the
 * tooltip — floored so the display never claims more than is true (99.6%
 * shows "99%" amber, not a "100%" that says Claude is paused).
 */
export function shownPercent(spend: SpendLimit & { percent: number }): number {
  return Math.floor(spend.percent);
}

/** What the status-bar item shows, as data (the component renders it). */
export type SpendItemView =
  | { kind: "total"; text: string; color: string | null }
  | { kind: "percent"; text: string; color: string }
  | { kind: "bar"; fill: number; color: string; over: boolean };

/**
 * The item for a style. `color: null` means the neutral status color. Percent
 * and bar need a readable limit; without one they fall back to the total.
 */
export function spendItemView(
  spend: SpendLimit,
  style: SpendDisplay,
): SpendItemView {
  const total = formatMoney(spend.used, spend.currency);
  if (!hasSpendLimit(spend)) return { kind: "total", text: total, color: null };
  const pct = shownPercent(spend);
  if (style === "percent")
    return { kind: "percent", text: `${pct}%`, color: spendColor(pct) };
  if (style === "bar")
    return {
      kind: "bar",
      fill: Math.min(pct, 100),
      color: spendColor(pct),
      over: pct >= 100,
    };
  // Text (R): quiet until near the limit.
  if (pct < SPEND_NEAR_PERCENT)
    return { kind: "total", text: total, color: null };
  return {
    kind: "total",
    text: `${total} / ${formatMoney(spend.limit, spend.currency)}`,
    color: spendColor(pct),
  };
}

/** The reset instant, when the response gives a usable FUTURE one. A past
 *  date (a stale snapshot after the period rolled) is treated as unknown. */
function futureReset(spend: SpendLimit, now: number): Date | null {
  const at = spend.resetsAt ? new Date(spend.resetsAt) : null;
  if (!at || Number.isNaN(at.getTime()) || at.getTime() <= now) return null;
  return at;
}

/** Reset line: the response's own date when it has one, else the period. */
function resetLine(spend: SpendLimit, now: number): string {
  const at = futureReset(spend, now);
  if (!at) return "Resets at the start of your next billing period.";
  const days = Math.max(0, Math.ceil((at.getTime() - now) / 86_400_000));
  // UTC, like the pace math: an Oct 1 00:00Z reset is "Oct 1", not "Sep 30".
  const date = at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `Resets ${date} · ${days} day${days === 1 ? "" : "s"} left.`;
}

/**
 * Where even spending would be today, when the reset date is known. The
 * period is taken as the calendar month ending at the reset (help center:
 * spend limits are monthly and reset with the billing period), computed in
 * UTC with the day clamped (a Mar 31 reset starts Feb 28, not Mar 3).
 */
export function evenPaceAmount(spend: SpendLimit, now: number): number | null {
  if (!hasSpendLimit(spend)) return null;
  const end = futureReset(spend, now);
  if (!end) return null;
  const start = new Date(end);
  start.setUTCDate(1);
  start.setUTCMonth(start.getUTCMonth() - 1);
  const daysInPrev = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
  ).getUTCDate();
  start.setUTCDate(Math.min(end.getUTCDate(), daysInPrev));
  const span = end.getTime() - start.getTime();
  const elapsed = Math.min(1, Math.max(0, (now - start.getTime()) / span));
  return spend.limit * elapsed;
}

/**
 * Tooltip (and the panel's text), the same whichever style is selected.
 * `context: "panel"` drops the line that explains the status-bar fallback.
 */
export function spendTooltip(
  spend: SpendLimit,
  style: SpendDisplay,
  now = Date.now(),
  context: "bar" | "panel" = "bar",
): string {
  const used = formatMoney(spend.used, spend.currency);
  if (!hasSpendLimit(spend)) {
    const limitLine =
      spend.limitStatus === "unreadable"
        ? "Your spend limit couldn't be read from the usage response."
        : "No spend limit is set.";
    const why =
      style === "text" || context === "panel"
        ? ""
        : "\nWithout a readable limit there's no percentage, so the total is shown.";
    return `${used} spent this billing period. ${limitLine}${why}\n${resetLine(spend, now)}`;
  }
  const pct = shownPercent(spend);
  const lines = [
    `${used} of your ${formatMoney(spend.limit, spend.currency)} spend limit (${pct}%)`,
    resetLine(spend, now),
  ];
  const even = evenPaceAmount(spend, now);
  if (even !== null && pct < 100) {
    lines.push(
      `${spend.used > even ? "Ahead of" : "Under"} pace: even spending would be ${formatMoney(even, spend.currency)} by today.`,
    );
  }
  if (pct >= 100) {
    lines.push(
      "At or over your limit: Claude is paused until an admin raises it or the next billing period starts.",
    );
  } else if (pct >= SPEND_NEAR_PERCENT) {
    lines.push("Near your limit. If you need more, ask an admin to raise it.");
  }
  return lines.join("\n");
}
