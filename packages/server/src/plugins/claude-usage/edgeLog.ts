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
 *
 * Scope: the edges are TRANSPORT health. Call sites stamp success() on any
 * completed HTTP exchange — 401/403/429/!ok included, since those surface
 * through their own status channels — and failure() only on a throw
 * (connect/parse). Anything else wedges: success only on the fully-ok path
 * would leave the edge `failing` through an expired-credential period and
 * silence a later, distinct outage forever. A mid-outage change of failure
 * CAUSE is announced once per change (not suppressed as a repeat) so the
 * operator isn't debugging last week's error message.
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
  let announcedCause = "";
  return {
    failure(err: unknown): void {
      failures++;
      const cause = firstLine(err);
      if (failing) {
        // Same outage, new root cause (e.g. ECONNREFUSED → TLS error after a
        // cert change): announce the change once, keep suppressing repeats.
        if (cause !== announcedCause) {
          announcedCause = cause;
          console.error(`${label} failure cause changed: ${cause}`);
        }
        return;
      }
      failing = true;
      announcedCause = cause;
      console.error(
        `${label} failed: ${cause} (suppressing repeats until it recovers)`,
      );
    },
    success(): void {
      if (!failing) return;
      failing = false;
      console.log(`${label} recovered after ${failures} failed attempt(s)`);
      failures = 0;
      announcedCause = "";
    },
  };
}
