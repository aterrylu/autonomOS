/**
 * Codex usage aggregator — the single entry point the route calls.
 *
 * Two-tier, strictly read-only (ADR-048 — never refresh/rotate/write the token):
 *   1. PRIMARY  — the live `/wham/usage` endpoint (real-time, richest).
 *   2. FALLBACK — the freshest on-disk rollout snapshot (last-known) when the
 *      token is expired/absent or the endpoint is unreachable.
 * When there's no Codex signal at all (no auth.json, no rollout), we return
 * `needsData` so the dashboard hides its status-bar item rather than nag.
 *
 * There is deliberately NO token-refresh path here. An expired token falls
 * through to the rollout fallback — it is NEVER refreshed (that would rotate the
 * token and break the Codex CLI login). See auth.ts for the full rationale.
 */

import { createHash } from "node:crypto";
import { createSingleFlight } from "../singleFlight.js";
import {
  type CodexAuth,
  readChatGptBaseUrl,
  readCodexAuth,
  readCodexIdentity,
} from "./auth.js";
import { type RolloutSnapshot, readFreshestRollout } from "./rolloutScanner.js";
import type {
  CodexAccountInfo,
  CodexErrorKind,
  CodexUsageData,
} from "./types.js";
import {
  type CodexUsageFetcher,
  fetchCodexUsage,
  mapCodexUsage,
} from "./usageApi.js";

/** 60s cache aligned with the dashboard's poll — at most one real fetch/minute.
 *  A 429 backs off longer since the endpoint is shared with the Codex CLI. */
const CACHE_TTL = 60_000;
const CACHE_TTL_429 = 5 * 60_000;

let cached: { data: CodexUsageData; expiresAt: number; fp: string } | null =
  null;
let lastGood: { data: CodexUsageData; fp: string } | null = null;

/** Short, non-reversible fingerprint keying the cache to a specific token, so an
 *  account switch (new token) never serves the previous account's numbers. */
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

function emptyBase(): Omit<CodexUsageData, "fetchedAt"> {
  return {
    secondary: null,
    primary: null,
    additionalLimits: [],
    credits: null,
    planType: null,
    account: {},
    source: "live",
  };
}

function needsDataResult(account: CodexAccountInfo): CodexUsageData {
  return {
    ...emptyBase(),
    account,
    fetchedAt: new Date().toISOString(),
    needsData: true,
  };
}

function errorResult(
  error: string,
  errorKind: CodexErrorKind,
  account: CodexAccountInfo,
): CodexUsageData {
  return {
    ...emptyBase(),
    account,
    fetchedAt: new Date().toISOString(),
    error,
    errorKind,
  };
}

/** Build a snapshot from the on-disk rollout fallback. `source: "rollout"` +
 *  `snapshotAt` let the UI show an honest "last-known · Xm ago" age.
 *
 *  `failure` rides the CAUSE of the fallback along with the numbers. Without
 *  it, an expired/rejected token was indistinguishable from a healthy fallback
 *  whenever any rollout file existed (the normal case for an active Codex
 *  user): no errorKind meant `normalizeCodexUsage` reported `authError: false`,
 *  so an armed usage-queue pane held forever WITHOUT the one-shot re-auth
 *  warning built for exactly that state, and the panel showed aging numbers
 *  with no re-auth hint. */
function fromRollout(
  snap: RolloutSnapshot,
  account: CodexAccountInfo,
  failure?: { error: string; errorKind: CodexErrorKind },
): CodexUsageData {
  return {
    secondary: snap.secondary,
    primary: snap.primary,
    additionalLimits: [],
    credits: snap.credits,
    planType: snap.planType ?? account.planType ?? null,
    account,
    source: "rollout",
    snapshotAt: snap.snapshotAt,
    fetchedAt: new Date().toISOString(),
    ...(failure ?? {}),
  };
}

/** De-dupe concurrent cache-missing reads (see {@link createSingleFlight}) —
 * this endpoint is shared with the Codex CLI and a 429 pins the display for 5
 * minutes, so a multi-tab stampede is expensive. */
const singleFlight = createSingleFlight<CodexUsageData>();

/** The cache entry for this token, if it exists and is still fresh. The
 * fingerprint match is what stops an account switch from serving the previous
 * account's numbers. */
function cachedFor(fp: string): CodexUsageData | null {
  if (cached && cached.expiresAt > Date.now() && cached.fp === fp)
    return cached.data;
  return null;
}

/**
 * Resolve the current Codex usage snapshot. `fetcher` is injectable so tests
 * exercise the live path without network (and assert the read-only contract).
 */
export async function getCodexUsage(
  fetcher?: CodexUsageFetcher,
): Promise<CodexUsageData> {
  const auth = readCodexAuth();
  const identity = readCodexIdentity();
  const account: CodexAccountInfo = {
    email: identity?.email,
    planType: identity?.planType,
  };

  // No usable credential: still show the last-known rollout if one exists;
  // otherwise there's genuinely no Codex signal → hide the UI (needsData).
  if (!auth) {
    const snap = readFreshestRollout();
    return snap ? fromRollout(snap, account) : needsDataResult(account);
  }

  const fp = fingerprint(auth.accessToken);
  return (
    cachedFor(fp) ??
    singleFlight(fp, () => fetchCodexUsageSnapshot(auth, account, fp, fetcher))
  );
}

async function fetchCodexUsageSnapshot(
  auth: CodexAuth,
  account: CodexAccountInfo,
  fp: string,
  fetcher?: CodexUsageFetcher,
): Promise<CodexUsageData> {
  const now = Date.now();
  // Re-check under the flight: a caller that queued behind a completed flight
  // reads the fresh cache instead of refetching.
  const hit = cachedFor(fp);
  if (hit) return hit;

  // Expired token: NEVER refresh — fall back to the rollout snapshot, but
  // carry the stale-token state with it (see fromRollout's failure param).
  if (auth.expiresAt <= now) {
    const staleFailure = {
      error: "Your Codex login has expired. Run `codex` to re-authenticate.",
      errorKind: "stale_token" as const,
    };
    const snap = readFreshestRollout();
    if (snap) return fromRollout(snap, account, staleFailure);
    return errorResult(staleFailure.error, staleFailure.errorKind, account);
  }

  // Live path (primary).
  const baseUrl = readChatGptBaseUrl();
  const result = await fetchCodexUsage(
    auth.accessToken,
    auth.accountId,
    baseUrl,
    fetcher,
  );

  if (result.status === "ok") {
    const mapped = mapCodexUsage(result.data);
    const data: CodexUsageData = {
      secondary: mapped.secondary,
      primary: mapped.primary,
      additionalLimits: mapped.additionalLimits,
      credits: mapped.credits,
      planType: mapped.planType ?? account.planType ?? null,
      account,
      source: "live",
      fetchedAt: new Date().toISOString(),
    };
    lastGood = { data, fp };
    cached = { data, expiresAt: now + CACHE_TTL, fp };
    return data;
  }

  // Live failed → prefer the on-disk fallback so the panel stays populated,
  // with the failure riding along: credential failures must reach the UI and
  // the usage-queue's authError path; transient ones render as "delayed".
  const liveFailure =
    result.status === "unauthorized"
      ? {
          error:
            "Codex rejected the login token. Run `codex` to re-authenticate. Showing last-known usage.",
          errorKind: "unauthorized" as const,
        }
      : result.status === "rate_limited"
        ? {
            error:
              "OpenAI is rate-limiting usage requests — showing last-known usage.",
            errorKind: "rate_limited" as const,
          }
        : {
            error:
              "The Codex usage API is unreachable — showing last-known usage.",
            errorKind: "unavailable" as const,
          };
  const snap = readFreshestRollout();
  if (snap) {
    const data = fromRollout(snap, account, liveFailure);
    // Cache the fallback briefly so a shared-endpoint 429 isn't re-hit every
    // poll; a plain outage retries the live path sooner.
    const ttl = result.status === "rate_limited" ? CACHE_TTL_429 : CACHE_TTL;
    cached = { data, expiresAt: now + ttl, fp };
    return data;
  }

  // No fallback either — surface the live failure with the right remedy.
  if (result.status === "unauthorized") {
    return errorResult(
      "Codex rejected the login token. Run `codex` to re-authenticate.",
      "unauthorized",
      account,
    );
  }
  if (result.status === "rate_limited") {
    // Serve the last good LIVE snapshot if we have one — but mark it stale
    // (source: rollout + snapshotAt) so the UI shows its age honestly instead
    // of presenting old numbers as current "live" data.
    if (lastGood && lastGood.fp === fp) {
      const stale: CodexUsageData = {
        ...lastGood.data,
        source: "rollout",
        snapshotAt: lastGood.data.fetchedAt,
      };
      cached = { data: stale, expiresAt: now + CACHE_TTL_429, fp };
      return stale;
    }
    // No fallback data at all — cache the rate-limited state ITSELF so the
    // shared-endpoint backoff actually holds. Without this the errorResult is
    // uncached and every 60s poll re-hits an endpoint we share with the Codex
    // CLI, prolonging the limit.
    const errored = errorResult(
      "OpenAI is rate-limiting usage requests right now. Your login is fine — this clears on its own in a few minutes.",
      "rate_limited",
      account,
    );
    cached = { data: errored, expiresAt: now + CACHE_TTL_429, fp };
    return errored;
  }
  return errorResult(
    "The Codex usage API is temporarily unavailable. Your login is fine — retry in a moment.",
    "unavailable",
    account,
  );
}

/** Clear cached usage — exported for tests + future settings changes. */
export function invalidateCodexUsageCache(): void {
  cached = null;
  lastGood = null;
}
