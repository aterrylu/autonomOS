/**
 * Rate limit fetcher — queries Claude's OAuth usage API.
 *
 * Reads OAuth credentials from macOS Keychain, refreshes the token
 * if expired, and calls api.anthropic.com/api/oauth/usage for live
 * rate limit data including 5h, 7d, model-specific, and extra usage.
 */

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

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
  rateLimitTier?: string;
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
}

const USAGE_API = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_URL = "https://api.anthropic.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const KEYCHAIN_ACCOUNT = "Claude Code";
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");

/** In-memory cache with adaptive TTL */
let cached: { data: RateLimitData; expiresAt: number } | null = null;
/** Last successful API response — survives cache expiry for 429 fallback */
let lastGoodData: RateLimitData | null = null;
const CACHE_TTL = 60_000; // 1 min default
const CACHE_TTL_429 = 5 * 60_000; // 5 min backoff on rate limit

interface StoredCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    subscriptionType?: string;
    rateLimitTier?: string;
    email?: string;
    organization?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function readKeychainCredentials(): StoredCredentials | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
      ],
      { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readFileCredentials(): StoredCredentials | null {
  try {
    const raw = readFileSync(CREDENTIALS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeKeychainCredentials(creds: StoredCredentials): void {
  if (process.platform !== "darwin") return;
  try {
    const json = JSON.stringify(creds);
    // Delete existing then add new
    try {
      execFileSync(
        "security",
        [
          "delete-generic-password",
          "-s",
          KEYCHAIN_SERVICE,
          "-a",
          KEYCHAIN_ACCOUNT,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
    } catch {
      // May not exist yet
    }
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        KEYCHAIN_ACCOUNT,
        "-w",
        json,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    // Keychain write failed — not critical, token still works for this session
  }
}

interface RefreshResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  organization?: { name: string };
  account?: { email_address: string };
}

async function refreshToken(
  refreshTk: string,
): Promise<RefreshResponse | null> {
  try {
    const res = await fetch(REFRESH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshTk,
        client_id: CLIENT_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
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
}

async function fetchUsageData(accessToken: string): Promise<UsageResult> {
  try {
    const res = await fetch(USAGE_API, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.72",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) return { data: null, rateLimited: true };
    if (!res.ok) return { data: null, rateLimited: false };
    return { data: await res.json(), rateLimited: false };
  } catch {
    return { data: null, rateLimited: false };
  }
}

export async function getRateLimits(): Promise<RateLimitData> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.data;

  // Read credentials from keychain (primary) or file (fallback)
  const creds = readKeychainCredentials() ?? readFileCredentials();
  if (!creds?.claudeAiOauth) {
    return errorResult("No Claude Code credentials found");
  }

  const oauth = creds.claudeAiOauth;
  const account: AccountInfo = {
    email: oauth.email,
    organization: oauth.organization,
    subscriptionType: oauth.subscriptionType,
    rateLimitTier: oauth.rateLimitTier,
  };

  let accessToken = oauth.accessToken;
  const tokenExpired = oauth.expiresAt && oauth.expiresAt < now;

  // Refresh if expired
  if (tokenExpired) {
    const refreshed = await refreshToken(oauth.refreshToken);
    if (!refreshed) {
      return errorResult("Token expired and refresh failed");
    }
    accessToken = refreshed.access_token;

    // Update account info from refresh response
    if (refreshed.account?.email_address) {
      account.email = refreshed.account.email_address;
    }
    if (refreshed.organization?.name) {
      account.organization = refreshed.organization.name;
    }

    // Persist refreshed credentials (including email/org for next startup)
    creds.claudeAiOauth = {
      ...oauth,
      accessToken: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      expiresAt: now + refreshed.expires_in * 1000,
      email: account.email,
      organization: account.organization,
    };
    writeKeychainCredentials(creds);
  }

  // Fetch usage data (fall back to last good response on failure/429)
  const { data: body, rateLimited } = await fetchUsageData(accessToken);
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
    account,
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
