/**
 * Edge-triggered failure logging for pollers.
 *
 * A poller that logs every failed attempt turns an offline laptop into log
 * spam: the live install's usage poller wrote a 15-line network stack every
 * poll cycle while the machine was off-network — 111 occurrences ≈ 13% of the
 * entire rotating log (2026-08-08 audit). The signal is the TRANSITION, not
 * the repetition: log one line when a healthy poller starts failing, one line
 * (with the failure count) when it recovers, and nothing in between.
 *
 * Message-only on purpose — a connect timeout's stack trace identifies the
 * HTTP client's internals, not the cause, and the first line already says
 * everything actionable ("Failed to connect to the server").
 */
export interface EdgeLogger {
  /** Record a failed attempt; logs only on the healthy→failing edge. */
  failure(err: unknown): void;
  /** Record a successful attempt; logs only on the failing→healthy edge. */
  success(): void;
}

/** First line of the error's message — enough to say what went wrong without
 *  reproducing a transport stack every poll. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const nl = message.indexOf("\n");
  return nl === -1 ? message : `${message.slice(0, nl)} …`;
}

export function createEdgeLogger(label: string): EdgeLogger {
  let failing = false;
  let failures = 0;
  return {
    failure(err: unknown): void {
      failures++;
      if (failing) return;
      failing = true;
      console.error(
        `${label} failed: ${firstLine(err)} (suppressing repeats until it recovers)`,
      );
    },
    success(): void {
      if (!failing) return;
      failing = false;
      console.log(`${label} recovered after ${failures} failed attempt(s)`);
      failures = 0;
    },
  };
}
