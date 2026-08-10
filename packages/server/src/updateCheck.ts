// Server-side update-availability check (ADR-077 §6).
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
import {
  compareSemver,
  DEFAULT_RELEASE_API_BASE,
  DEFAULT_RELEASE_REPO,
  resolveReleaseOverrides,
} from "./upgrade.js";
import { getServerVersion } from "./version.js";

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
  /**
   * GitHub release-notes page for `latest`, or null. Only constructed for
   * the canonical repo — an AUTONOMOS_RELEASE_REPO override points at a
   * repository whose web layout we can't assume, so the badge simply
   * renders without a link there.
   */
  releaseUrl: string | null;
};

let state: UpdateCheckState = {
  latest: null,
  updateAvailable: false,
  checkedAt: null,
  releaseUrl: null,
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
 *
 * Failure taxonomy — user-facing silence is deliberate everywhere (the
 * badge simply doesn't show), but the OPERATOR gets one log line for the
 * failures that aren't plain offline, so "no update", "offline", and
 * "checker broken since March" stay distinguishable in autonomos.log:
 *   - network throw (offline/DNS/timeout): fully silent, the documented case
 *   - HTTP non-200 (renamed repo → 404, rate-limit → 403): console.warn —
 *     these persist forever and would otherwise kill the feature invisibly
 *   - anything thrown AFTER the fetch is a programming error and is NOT
 *     caught here: only the network I/O sits inside the try.
 */
export async function runUpdateCheck(
  apiBase?: string,
  repo?: string,
): Promise<UpdateCheckState> {
  // Same source resolution as `autonomos upgrade` — the SHARED resolver,
  // guard rails included (loud warn when an override is set; refuse a
  // non-https non-loopback base). Otherwise, on a fork/mirror using the
  // documented escape hatch, the badge would check a DIFFERENT repository
  // than the command it advertises — and unlike the CLI, a bare env read
  // here would skip the validation the CLI enforces.
  if (apiBase === undefined && repo === undefined) {
    const overrides = resolveReleaseOverrides();
    if ("error" in overrides) {
      console.warn(`[update-check] skipping check: ${overrides.error}`);
      return state;
    }
    apiBase = overrides.releaseApiBase ?? DEFAULT_RELEASE_API_BASE;
    repo = overrides.releaseRepo ?? DEFAULT_RELEASE_REPO;
  } else {
    apiBase = apiBase ?? DEFAULT_RELEASE_API_BASE;
    repo = repo ?? DEFAULT_RELEASE_REPO;
  }
  let resp: Response;
  let release: { tag_name?: string };
  try {
    resp = await fetch(`${apiBase}/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.warn(
        `[update-check] releases API returned ${resp.status} for ${repo} — ` +
          "keeping last-known state (disable with settings updateCheck:false)",
      );
      return state;
    }
    release = (await resp.json()) as { tag_name?: string };
  } catch {
    // Offline / DNS-less / timed-out box: keep last-known, stay quiet.
    // The badge not showing IS the correct offline behavior.
    return state;
  }

  if (typeof release.tag_name !== "string") return state;
  const latest = release.tag_name.replace(/^v/, "");
  // Prefix match: a hypothetical v0.6.0-rc.1 would pass and compare equal
  // to 0.6.0 (compareSemver strips prereleases) — unreachable today because
  // GitHub's releases/latest excludes prereleases.
  if (!/^\d+\.\d+\.\d+/.test(latest)) return state;

  const current = getServerVersion();
  state = {
    latest,
    updateAvailable:
      current !== "unknown" && compareSemver(current, latest) < 0,
    checkedAt: new Date().toISOString(),
    releaseUrl:
      repo === DEFAULT_RELEASE_REPO
        ? `https://github.com/${repo}/releases/tag/v${latest}`
        : null,
  };
  return state;
}

/**
 * Start the background cadence. Call once at server boot. Respects the
 * settings toggle at each firing (so flipping it off stops future checks
 * without a restart; already-cached state remains served).
 */
// Increments on every stop — an in-flight tick from an older generation
// must not reschedule after stopUpdateCheck ran (clearTimeout only cancels
// the PENDING handle; a tick that already fired and is awaiting its fetch
// would otherwise resurrect the chain, and after a stop/start pair the
// orphan chain would be unreachable forever).
let generation = 0;

export function startUpdateCheck(initialDelayMs = INITIAL_DELAY_MS): void {
  if (timer) return;
  const myGeneration = generation;
  const tick = async (): Promise<void> => {
    try {
      if (isUpdateCheckEnabled()) {
        await runUpdateCheck();
      }
    } catch (err) {
      // Belt over runUpdateCheck's own guarantees: an unhandled rejection
      // here would BOTH kill the reschedule (checks silently die forever)
      // AND crash the daemon under Node's default policy — a version check
      // must never be able to take the server down.
      console.warn(
        `[update-check] tick failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (generation !== myGeneration) return; // stopped while in flight
    const jitter = Math.floor(Math.random() * JITTER_MS);
    timer = setTimeout(tick, CHECK_INTERVAL_MS + jitter);
    timer.unref(); // never keep the process alive for a version check
  };
  timer = setTimeout(tick, initialDelayMs);
  timer.unref();
}

export function stopUpdateCheck(): void {
  generation += 1;
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
}

/** Test hook — reset the module cache between tests. */
export function _resetUpdateCheckForTesting(): void {
  stopUpdateCheck();
  state = {
    latest: null,
    updateAvailable: false,
    checkedAt: null,
    releaseUrl: null,
  };
}
