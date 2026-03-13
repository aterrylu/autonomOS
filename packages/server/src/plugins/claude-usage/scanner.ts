/**
 * Claude usage fetcher — queries claude.ai's internal usage API.
 *
 * Uses a session cookie (from browser) to authenticate. The cookie
 * is read from CLAUDE_SESSION_COOKIE env var set in .env.
 *
 * Uses impit (Rust-based browser impersonation) to match Chrome's
 * TLS fingerprint so Cloudflare doesn't block the request.
 *
 * Flow:
 *   1. Extract orgId from cookie (lastActiveOrg) or bootstrap API
 *   2. GET /api/organizations/{orgId}/usage → rate limit data
 */

import { Impit } from "impit";

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
  /** True when CLAUDE_SESSION_COOKIE is not set */
  needsSetup?: boolean;
}

const USAGE_URL = "https://claude.ai/api/organizations";
const BOOTSTRAP_URL = "https://claude.ai/api/bootstrap";

/** Shared impit client — reuses connections and TLS state */
const impit = new Impit({ browser: "chrome" });

/** In-memory cache */
let cached: { data: RateLimitData; expiresAt: number } | null = null;
let lastGoodData: RateLimitData | null = null;
const CACHE_TTL = 60_000;
const CACHE_TTL_429 = 5 * 60_000;

/** Cached org ID — rarely changes */
let cachedOrgId: string | null = null;

function getSessionCookie(): string | null {
  return process.env.CLAUDE_SESSION_COOKIE?.trim() || null;
}

function buildCookieHeader(cookie: string): string {
  if (cookie.includes("sessionKey=")) return cookie;
  return `sessionKey=${cookie}`;
}

async function fetchOrgId(cookie: string): Promise<string | null> {
  if (cachedOrgId) return cachedOrgId;

  // Try extracting from cookie first
  const orgMatch = cookie.match(/lastActiveOrg=([^;]+)/);
  if (orgMatch) {
    cachedOrgId = orgMatch[1];
    return cachedOrgId;
  }

  // Fall back to bootstrap API
  try {
    const res = await impit.fetch(BOOTSTRAP_URL, {
      headers: { Cookie: buildCookieHeader(cookie) },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      account?: { memberships?: Array<{ organization?: { uuid?: string } }> };
    };
    const orgId =
      data?.account?.memberships?.[0]?.organization?.uuid ?? null;
    if (orgId) cachedOrgId = orgId;
    return orgId;
  } catch {
    return null;
  }
}

function parseWindow(
  raw: { utilization?: number; resets_at?: string } | null | undefined,
): RateLimitWindow | null {
  if (!raw || raw.utilization == null) return null;
  return { utilization: raw.utilization, resetsAt: raw.resets_at ?? "" };
}

interface UsageResult {
  data: Record<string, unknown> | null;
  rateLimited: boolean;
  unauthorized: boolean;
}

async function fetchUsageData(
  cookie: string,
  orgId: string,
): Promise<UsageResult> {
  try {
    const res = await impit.fetch(`${USAGE_URL}/${orgId}/usage`, {
      headers: { Cookie: buildCookieHeader(cookie) },
    });
    if (res.status === 429)
      return { data: null, rateLimited: true, unauthorized: false };
    if (res.status === 401 || res.status === 403) {
      cachedOrgId = null;
      return { data: null, rateLimited: false, unauthorized: true };
    }
    if (!res.ok) return { data: null, rateLimited: false, unauthorized: false };
    return {
      data: (await res.json()) as Record<string, unknown>,
      rateLimited: false,
      unauthorized: false,
    };
  } catch {
    return { data: null, rateLimited: false, unauthorized: false };
  }
}

export async function getRateLimits(): Promise<RateLimitData> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;

  const cookie = getSessionCookie();
  if (!cookie) {
    return {
      ...errorResult("CLAUDE_SESSION_COOKIE not set"),
      needsSetup: true,
    };
  }

  const orgId = await fetchOrgId(cookie);
  if (!orgId) {
    return errorResult(
      "Could not resolve organization — check your session cookie",
    );
  }

  const {
    data: body,
    rateLimited,
    unauthorized,
  } = await fetchUsageData(cookie, orgId);

  if (unauthorized) {
    return errorResult(
      "Session cookie expired or invalid — please update CLAUDE_SESSION_COOKIE in .env",
    );
  }

  if (!body) {
    const ttl = rateLimited ? CACHE_TTL_429 : CACHE_TTL;
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
