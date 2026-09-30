import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Context } from "hono";

/**
 * Failed-auth throttle for the PUBLIC listener (V2, ADR-117 follow-up 5).
 *
 * Before this, a wrong token cost an attacker nothing: the audit measured
 * ~24,900 guesses/s on loopback, so a short operator token fell in minutes.
 * The limiter makes guessing slow without ever locking the operator out for
 * long:
 *
 *  - **Only DISTINCT wrong credentials count.** A guesser must vary the value;
 *    a dashboard tab or script still holding a stale token (another instance's
 *    cookie, an old Bearer) repeats the same one. Counting repeats would lock
 *    the operator out of their own login page because of their own open tab.
 *  - **Per address:** FREE_FAILURES distinct failures, then each further
 *    failure locks the address for BASE_LOCK_MS·2^k, capped at MAX_LOCK_MS.
 *    While locked, requests are refused BEFORE any credential is evaluated, so
 *    the lockout actually limits the guess rate (answering slowly while still
 *    checking would not).
 *  - **Global:** when more than GLOBAL_MAX distinct failures happen across all
 *    addresses within GLOBAL_WINDOW_MS (IP rotation), any address with a
 *    recent failure is locked until the rate falls. A clean address is still
 *    evaluated, so a legitimate user elsewhere signs in normally.
 *  - **A success clears the address.**
 *  - **Bounded memory:** at most MAX_ADDRESSES records (least recently seen is
 *    evicted), each forgotten after IDLE_MS, and at most MAX_SEEN remembered
 *    failure hashes per address.
 *
 * The address is the TCP peer, never X-Forwarded-For (a header the attacker
 * controls). Behind a reverse proxy every client shares the proxy's address, so
 * the per-address limit behaves like the global one; that's named in ADR-124.
 */

export const FREE_FAILURES = 10;
export const BASE_LOCK_MS = 1_000;
export const MAX_LOCK_MS = 60_000;
export const GLOBAL_MAX = 300;
export const GLOBAL_WINDOW_MS = 60_000;
export const IDLE_MS = 15 * 60_000;
export const MAX_ADDRESSES = 10_000;
export const MAX_SEEN = 32;

interface AddressRecord {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
  /** Hashes of the wrong credentials this address already sent. */
  seen: string[];
}

export type Verdict = { ok: true } | { ok: false; retryAfterMs: number };

export class AuthFailureLimiter {
  private readonly records = new Map<string, AddressRecord>();
  /** Timestamps of recent distinct failures, all addresses (ring, pruned). */
  private globalFailures: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** May this address have a credential evaluated right now? */
  check(address: string): Verdict {
    const t = this.now();
    const rec = this.get(address, t);
    if (!rec) return { ok: true };
    if (rec.lockedUntil > t)
      return { ok: false, retryAfterMs: rec.lockedUntil - t };
    if (this.globalCount(t) > GLOBAL_MAX && rec.failures > 0) {
      const oldest = this.globalFailures[0] ?? t;
      return {
        ok: false,
        retryAfterMs: Math.max(1, oldest + GLOBAL_WINDOW_MS - t),
      };
    }
    return { ok: true };
  }

  /** A credential from this address failed. `credential` is the raw value,
   *  hashed here and never stored. Returns the lockout it triggered, if any. */
  recordFailure(address: string, credential: string): number {
    const t = this.now();
    const rec = this.get(address, t) ?? this.create(address, t);
    const h = createHash("sha256")
      .update(credential)
      .digest("base64url")
      .slice(0, 16);
    if (rec.seen.includes(h)) return 0; // a repeat, e.g. a stale tab: not a guess
    rec.seen.push(h);
    if (rec.seen.length > MAX_SEEN) rec.seen.shift();
    rec.failures += 1;
    this.globalFailures.push(t);
    if (rec.failures <= FREE_FAILURES) return 0;
    const lock = Math.min(
      MAX_LOCK_MS,
      BASE_LOCK_MS * 2 ** Math.min(30, rec.failures - FREE_FAILURES - 1),
    );
    rec.lockedUntil = t + lock;
    return lock;
  }

  /** A credential from this address was valid. */
  recordSuccess(address: string): void {
    this.records.delete(address);
  }

  /** For tests and diagnostics. */
  size(): number {
    return this.records.size;
  }

  private get(address: string, t: number): AddressRecord | undefined {
    const rec = this.records.get(address);
    if (!rec) return undefined;
    if (t - rec.lastSeen > IDLE_MS && rec.lockedUntil <= t) {
      this.records.delete(address);
      return undefined;
    }
    // Re-insert: Map iteration order is the LRU order.
    rec.lastSeen = t;
    this.records.delete(address);
    this.records.set(address, rec);
    return rec;
  }

  private create(address: string, t: number): AddressRecord {
    while (this.records.size >= MAX_ADDRESSES) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
    const rec: AddressRecord = {
      failures: 0,
      lockedUntil: 0,
      lastSeen: t,
      seen: [],
    };
    this.records.set(address, rec);
    return rec;
  }

  private globalCount(t: number): number {
    const cutoff = t - GLOBAL_WINDOW_MS;
    let i = 0;
    while (i < this.globalFailures.length && this.globalFailures[i] <= cutoff)
      i++;
    if (i > 0) this.globalFailures = this.globalFailures.slice(i);
    // Bounded: only the window matters, and a flood beyond 10× the ceiling
    // tells us nothing more.
    if (this.globalFailures.length > GLOBAL_MAX * 10)
      this.globalFailures = this.globalFailures.slice(-GLOBAL_MAX * 10);
    return this.globalFailures.length;
  }
}

/** `::ffff:1.2.3.4` and `1.2.3.4` are one client. */
export function normalizeAddress(addr: string | undefined): string {
  if (!addr) return "unknown";
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

/** The TCP peer of this request (never a forwarding header). */
export function peerAddress(c: Context): string {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  return normalizeAddress(env?.incoming?.socket?.remoteAddress);
}

/** One line per lockout, capped: an attack must not fill the log. Never
 *  includes a credential. */
export function cappedLockoutWarn(
  limit = 50,
  sink: (line: string) => void = console.warn,
): (address: string, lockMs: number) => void {
  let n = 0;
  return (address, lockMs) => {
    n += 1;
    if (n > limit) return;
    sink(
      `[auth] ${address} sent too many different wrong tokens; refusing its sign-in attempts for ${Math.ceil(lockMs / 1000)}s${n === limit ? " (further lockouts are not logged until restart)" : ""}`,
    );
  };
}
