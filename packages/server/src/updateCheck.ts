// Server-side update-availability check (ADR-072 §6).
//
// The DASHBOARD never calls GitHub — that was Terry's original objection to
// a version badge, and it's engineered out: the SERVER polls the releases
// API on a slow cadence and the dashboard reads the cached answer off the
// existing /api/system/version response.
//
// Contract with that endpoint (agreed with the API-conventions pass): the
// check must never run in a request handler, never block, and never fail
// the endpoint — /api/system/version doubles as the pid-file liveness
// probe's target and must stay a fast, always-200 read. On any failure the
// cache serves last-known-or-null; the badge simply doesn't show.
//
// Cadence: ~24h with jitter (Uptime Kuma checks 48h; aider 24h). At one
// request per day per instance, GitHub's unauthenticated 60 req/hr/IP limit
// is a non-issue; a CDN-hosted JSON is the documented scaling path if this
// ever ships beyond personal instances.
//
// Off switch: settings.json `updateCheck: false`. The documented default
// (ON) matches the actual default below — a docs/behavior mismatch on a
// phone-home flag is treated as a bug in its own right (see Gitea #22078).

import { getSettings } from "./settings.js";
import { compareSemver } from "./upgrade.js";
import { getServerVersion } from "./version.js";

const DEFAULT_RELEASE_REPO = "aterrylu/autonomOS";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// First check shortly after boot (the daemon typically restarts at most
// every few days — a pure 24h timer would leave a fresh boot blind for a
// day), delayed a few minutes so boot itself stays network-quiet.
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const JITTER_MS = 60 * 60 * 1000;

export type UpdateCheckState = {
  /** Newest published version, or null when unknown (never checked / failed / disabled). */
  latest: string | null;
  /** True only when `latest` is known AND newer than the running version. */
  updateAvailable: boolean;
  /** ISO timestamp of the last SUCCESSFUL check, or null. */
  checkedAt: string | null;
};

let state: UpdateCheckState = {
  latest: null,
  updateAvailable: false,
  checkedAt: null,
};
let timer: NodeJS.Timeout | undefined;

/** The cached answer — cheap, synchronous, safe to read in any handler. */
export function getUpdateCheckState(): UpdateCheckState {
  return state;
}

export function isUpdateCheckEnabled(): boolean {
  return getSettings().updateCheck !== false;
}

/**
 * Run one check now. Exposed for tests (with an injectable API base) and
 * for the interval below. Never throws; failure leaves the cache as-is.
 */
export async function runUpdateCheck(
  apiBase = "https://api.github.com",
  repo = DEFAULT_RELEASE_REPO,
): Promise<UpdateCheckState> {
  try {
    const resp = await fetch(`${apiBase}/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return state;
    const release = (await resp.json()) as { tag_name?: string };
    if (typeof release.tag_name !== "string") return state;
    const latest = release.tag_name.replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+/.test(latest)) return state;

    const current = getServerVersion();
    state = {
      latest,
      updateAvailable:
        current !== "unknown" && compareSemver(current, latest) < 0,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    // Offline / rate-limited / DNS-less box: keep last-known, stay quiet.
    // The badge not showing IS the correct offline behavior.
  }
  return state;
}

/**
 * Start the background cadence. Call once at server boot. Respects the
 * settings toggle at each firing (so flipping it off stops future checks
 * without a restart; already-cached state remains served).
 */
export function startUpdateCheck(): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    if (isUpdateCheckEnabled()) {
      await runUpdateCheck();
    }
    const jitter = Math.floor(Math.random() * JITTER_MS);
    timer = setTimeout(tick, CHECK_INTERVAL_MS + jitter);
    timer.unref(); // never keep the process alive for a version check
  };
  timer = setTimeout(tick, INITIAL_DELAY_MS);
  timer.unref();
}

export function stopUpdateCheck(): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

/** Test hook — reset the module cache between tests. */
export function _resetUpdateCheckForTesting(): void {
  stopUpdateCheck();
  state = { latest: null, updateAvailable: false, checkedAt: null };
}
