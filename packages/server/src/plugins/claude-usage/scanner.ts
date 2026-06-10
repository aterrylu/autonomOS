/**
 * Claude usage fetcher — queries claude.ai's internal usage API.
 *
 * Authenticates with a single credential: the session key
 * (CLAUDE_SESSION_KEY from settings or .env). The organization UUID is
 * resolved automatically from the session key via claude.ai's bootstrap
 * API — no org ID is required from the user.
 *
 * Uses impit (Rust-based browser impersonation) to match Chrome's
 * TLS fingerprint so Cloudflare doesn't block the request.
 *
 * Flow:
 *   1. Resolve orgId from the bootstrap API (cached after first lookup)
 *   2. GET /api/organizations/{orgId}/usage → rate limit data
 */

import { Impit } from "impit";
import { getSettings } from "../../settings.js";

export interface RateLimitWindow {
  utilization: number;
  resetsAt: string;
}

export interface ExtraUsage {
  isEnabled: boolean;
  monthlyLimit: number;
  usedCredits: number;
  utilization: number | null;
}

export interface AccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
}

export interface RateLimitData {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  sevenDaySonnet: RateLimitWindow | null;
  sevenDayOpus: RateLimitWindow | null;
  extraUsage: ExtraUsage | null;
  account: AccountInfo;
  fetchedAt: string;
  error?: string;
  /** True when CLAUDE_SESSION_KEY is not set */
  needsSetup?: boolean;
}

const USAGE_URL = "https://claude.ai/api/organizations";
const BOOTSTRAP_URL = "https://claude.ai/api/bootstrap";

/** Shared impit client — reuses connections and TLS state */
const impit = new Impit({ browser: "chrome" });

/** Minimal response shape consumed by the usage fetchers. */
interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * HTTP fetcher seam. Defaults to the real impit client; tests inject a
 * fake to exercise the bootstrap/usage flow deterministically without
 * network access (the repo's test runner can't mock the `impit` module).
 */
export type UsageFetcher = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<FetchResponse>;

const defaultFetcher: UsageFetcher = (url, init) => impit.fetch(url, init);

/** In-memory cache */
let cached: { data: RateLimitData; expiresAt: number } | null = null;
let lastGoodData: RateLimitData | null = null;
const CACHE_TTL = 60_000;
const CACHE_TTL_429 = 5 * 60_000;

/** Cached org ID — rarely changes */
let cachedOrgId: string | null = null;

/**
 * Build the auth cookie from the session key alone.
 *
 * The org ID is intentionally NOT appended — it's resolved from the
 * session key via the bootstrap API (see {@link fetchOrgId}). Any
 * lingering `claudeOrgId` in settings or `CLAUDE_ORG_ID` in the env is
 * ignored for back/forward compatibility.
 *
 * Exported for tests.
 */
export function getSessionCookie(): string | null {
  const settings = getSettings();
  const key =
    settings.claudeSessionKey?.trim() || process.env.CLAUDE_SESSION_KEY?.trim();
  return key ? `sessionKey=${key}` : null;
}

/** Clear cached data — call after settings change */
export function invalidateCache(): void {
  cached = null;
  cachedOrgId = null;
  lastGoodData = null;
}

function buildCookieHeader(cookie: string): string {
  if (cookie.includes("sessionKey=")) return cookie;
  return `sessionKey=${cookie}`;
}

/** Outcome of resolving the org UUID — lets callers give the user a
 * message that matches the actual failure instead of one generic error. */
type OrgIdStatus = "ok" | "unauthorized" | "no_org" | "error";

interface OrgIdResult {
  orgId: string | null;
  status: OrgIdStatus;
}

/**
 * Resolve the organization UUID for the given cookie.
 *
 * The session-key-only cookie carries no `lastActiveOrg`, so resolution
 * falls through to the bootstrap API. A manually-supplied full cookie
 * string that still contains `lastActiveOrg` is honored as a shortcut.
 * Result is cached. Exported for tests.
 *
 * Distinguishes the failure modes (`unauthorized` for an expired/invalid
 * key, `no_org` for a valid key with no organization, `error` for
 * network/parse problems) so the caller can surface an actionable message.
 */
export async function fetchOrgId(
  cookie: string,
  fetcher: UsageFetcher = defaultFetcher,
): Promise<OrgIdResult> {
  if (cachedOrgId) return { orgId: cachedOrgId, status: "ok" };

  // Honor an explicit lastActiveOrg if present (manual full-cookie paste).
  const orgMatch = cookie.match(/lastActiveOrg=([^;]+)/);
  if (orgMatch) {
    cachedOrgId = orgMatch[1];
    return { orgId: cachedOrgId, status: "ok" };
  }

  // Resolve from the bootstrap API using the session key alone.
  try {
    const res = await fetcher(BOOTSTRAP_URL, {
      headers: { Cookie: buildCookieHeader(cookie) },
    });
    if (res.status === 401 || res.status === 403) {
      return { orgId: null, status: "unauthorized" };
    }
    if (!res.ok) return { orgId: null, status: "error" };
    const data = (await res.json()) as {
      account?: { memberships?: Array<{ organization?: { uuid?: string } }> };
    };
    const orgId = data?.account?.memberships?.[0]?.organization?.uuid ?? null;
    if (!orgId) return { orgId: null, status: "no_org" };
    cachedOrgId = orgId;
    return { orgId, status: "ok" };
  } catch (err) {
    console.error("[claude-usage] bootstrap org resolution failed:", err);
    return { orgId: null, status: "error" };
  }
}

function parseWindow(
  raw: { utilization?: number; resets_at?: string } | null | undefined,
): RateLimitWindow | null {
  if (!raw || raw.utilization == null) return null;
  return { utilization: raw.utilization, resetsAt: raw.resets_at ?? "" };
}

type UsageStatus = "ok" | "rate_limited" | "unauthorized" | "error";

interface UsageResult {
  data: Record<string, unknown> | null;
  status: UsageStatus;
}

async function fetchUsageData(
  cookie: string,
  orgId: string,
  fetcher: UsageFetcher = defaultFetcher,
): Promise<UsageResult> {
  try {
    const res = await fetcher(`${USAGE_URL}/${orgId}/usage`, {
      headers: { Cookie: buildCookieHeader(cookie) },
    });
    if (res.status === 429) return { data: null, status: "rate_limited" };
    if (res.status === 401 || res.status === 403) {
      cachedOrgId = null;
      return { data: null, status: "unauthorized" };
    }
    if (!res.ok) return { data: null, status: "error" };
    return {
      data: (await res.json()) as Record<string, unknown>,
      status: "ok",
    };
  } catch (err) {
    console.error("[claude-usage] usage fetch failed:", err);
    return { data: null, status: "error" };
  }
}

export async function getRateLimits(
  fetcher: UsageFetcher = defaultFetcher,
): Promise<RateLimitData> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;

  const cookie = getSessionCookie();
  if (!cookie) {
    return {
      ...errorResult("CLAUDE_SESSION_KEY not set"),
      needsSetup: true,
    };
  }

  const org = await fetchOrgId(cookie, fetcher);
  if (org.status === "unauthorized") {
    return errorResult(
      "Session cookie expired or invalid — please update CLAUDE_SESSION_KEY in .env",
    );
  }
  if (org.status === "no_org") {
    // The bootstrap API returns 200 with an empty membership list for an
    // unrecognized/expired cookie (it treats it as logged-out), so this is
    // the path a bad session key actually lands on — point the user there.
    return errorResult(
      "Could not resolve your Claude organization — your session key may be invalid or expired. Update CLAUDE_SESSION_KEY.",
    );
  }
  if (!org.orgId) {
    return errorResult(
      "Could not resolve organization — check your session cookie",
    );
  }

  const { data: body, status } = await fetchUsageData(
    cookie,
    org.orgId,
    fetcher,
  );

  if (status === "unauthorized") {
    return errorResult(
      "Session cookie expired or invalid — please update CLAUDE_SESSION_KEY in .env",
    );
  }

  if (!body) {
    const ttl = status === "rate_limited" ? CACHE_TTL_429 : CACHE_TTL;
    if (lastGoodData) {
      cached = { data: lastGoodData, expiresAt: now + ttl };
      return lastGoodData;
    }
    return errorResult("Usage API unavailable");
  }

  const extra = body.extra_usage as {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number | null;
  } | null;

  const data: RateLimitData = {
    fiveHour: parseWindow(
      body.five_hour as { utilization?: number; resets_at?: string },
    ),
    sevenDay: parseWindow(
      body.seven_day as { utilization?: number; resets_at?: string },
    ),
    sevenDaySonnet: parseWindow(
      body.seven_day_sonnet as { utilization?: number; resets_at?: string },
    ),
    sevenDayOpus: parseWindow(
      body.seven_day_opus as { utilization?: number; resets_at?: string },
    ),
    extraUsage: extra?.is_enabled
      ? {
          isEnabled: true,
          monthlyLimit: extra.monthly_limit ?? 0,
          usedCredits: extra.used_credits ?? 0,
          utilization: extra.utilization ?? null,
        }
      : null,
    account: {},
    fetchedAt: new Date().toISOString(),
  };

  lastGoodData = data;
  cached = { data, expiresAt: now + CACHE_TTL };
  return data;
}

function errorResult(error: string): RateLimitData {
  return {
    fiveHour: null,
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    account: {},
    fetchedAt: new Date().toISOString(),
    error,
  };
}
