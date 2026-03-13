/**
 * Shared utility functions for the Claude usage plugin.
 */

/** Returns a color hex string based on utilization percentage. */
export function utilizationColor(pct: number): string {
  if (pct >= 80) return "#ea6c73"; // red
  if (pct >= 60) return "#e6b450"; // yellow
  return "#238636"; // green
}

/** Human-readable time remaining until a reset timestamp. */
export function timeUntilReset(resetsAt: string): string {
  if (!resetsAt) return "";
  const resetDate = new Date(resetsAt);
  const ms = resetDate.getTime() - Date.now();
  if (ms <= 0) return "now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    resetDate.getDate() === tomorrow.getDate() &&
    resetDate.getMonth() === tomorrow.getMonth();
  const time = resetDate.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (isTomorrow) return `Tomorrow ${time}`;
  const day = resetDate.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${day} ${time}`;
}
