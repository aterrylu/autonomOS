import { useEffect, useState } from "react";
import type { PaneConnection } from "../terminal/connectionWatch";

// Same dot colors as the status-bar indicator, so the two read as one system:
// amber = degraded/unconfirmed, red = connection lost.
const AMBER = "#d29922";
const RED = "#ea6c73";
const GRAY = "#8b949e";

function keys(n: number): string {
  return `${n} keystroke${n === 1 ? "" : "s"}`;
}

/** The chip's text + dot for a pane state, or null when there is nothing to
 *  say. Exported for tests. Wording is per CAUSE (the watchdog tells them
 *  apart): a dead pane socket is a lost connection; a silent agent behind a
 *  healthy connection is not a disconnect. */
export function describePaneConnection(
  c: PaneConnection,
  now: number,
): { text: string; color: string; subtle?: boolean } | null {
  switch (c.kind) {
    case "unacked":
      return {
        color: AMBER,
        text: `Not reaching server… · ${keys(c.keys)} waiting`,
      };
    case "waiting":
      // Deliberately quiet: it appears ~2s into any slow first echo and
      // usually resolves on its own — a hint, not an alarm.
      return { color: GRAY, text: "Waiting for agent…", subtle: true };
    case "lost":
      return {
        color: RED,
        text:
          c.droppedKeys > 0
            ? `Connection lost · reconnecting… · ${keys(c.droppedKeys)} not sent`
            : "Connection lost · reconnecting…",
      };
    case "silent": {
      const s = Math.max(0, Math.round((now - c.since) / 1000));
      return { color: AMBER, text: `Agent not responding · ${s}s` };
    }
    default:
      if (c.droppedKeys <= 0) return null;
      return {
        color: AMBER,
        text: c.exact
          ? `Reconnected · ${keys(c.droppedKeys)} typed while disconnected ${c.droppedKeys === 1 ? "wasn't" : "weren't"} sent`
          : `Reconnected · ${keys(c.droppedKeys)} typed while disconnected may not have been sent`,
      };
  }
}

/**
 * Per-pane connection chip (top-right). Informational only — input stays
 * live in every state; nothing is blocked or retried automatically beyond the
 * pane's own reconnect.
 */
export function PaneConnectionChip({
  connection,
}: {
  connection: PaneConnection;
}) {
  const [now, setNow] = useState(() => Date.now());
  const counting =
    connection.kind === "silent" || connection.kind === "waiting";
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [counting]);

  // Same transition-render rule as the status-bar counter: never show a
  // stale "0s" before the interval's first tick.
  const d = describePaneConnection(
    connection,
    counting ? Math.max(now, Date.now()) : now,
  );
  if (!d) return null;
  return (
    // <output> carries the implicit "status" live-region role.
    <output
      aria-live="polite"
      data-testid="pane-connection-chip"
      className={
        d.subtle
          ? // Same box and position as the loud chips (no layout shift) —
            // just muted: no border accent, no shadow, dimmed text.
            "pointer-events-none absolute top-2 right-3 z-10 flex max-w-[80%] items-center gap-1.5 rounded-full border border-transparent bg-card/70 px-2.5 py-0.5 text-xs text-muted-foreground"
          : "pointer-events-none absolute top-2 right-3 z-10 flex max-w-[80%] items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-0.5 text-xs text-foreground shadow-lg"
      }
    >
      <span
        aria-hidden="true"
        className="inline-block shrink-0 rounded-full"
        style={{ width: 7, height: 7, background: d.color }}
      />
      <span className="truncate">{d.text}</span>
    </output>
  );
}
