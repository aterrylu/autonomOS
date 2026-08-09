/**
 * In-flight de-duplication for the usage scanners.
 *
 * Without it, every concurrent caller that misses the cache fires its OWN
 * upstream request — and the usage endpoints are read from two directions at
 * once (the status-bar poll and the usage-queue cap read, times N open tabs),
 * so a TTL boundary produced a small thundering herd against endpoints that
 * 429 (and a 429 pins the display for 5 minutes).
 *
 * Callers key by credential fingerprint so a key/account switch never joins the
 * previous credential's flight. Each scanner owns its own map (one factory call
 * per module), so keys can never collide across providers.
 */
export type SingleFlight<T> = (
  key: string,
  compute: () => Promise<T>,
) => Promise<T>;

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();
  return (key, compute) => {
    const existing = inflight.get(key);
    if (existing) return existing;
    // The `finally` is load-bearing: without it a settled flight would stay in
    // the map and every later read would resolve to that first result forever.
    const flight = compute().finally(() => inflight.delete(key));
    inflight.set(key, flight);
    return flight;
  };
}
