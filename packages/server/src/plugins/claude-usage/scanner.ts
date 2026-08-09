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

import { createHash } from "node:crypto";
import { Impit } from "impit";
import { getSettings, isAutoDetectAccountEnabled } from "../../settings.js";
import { createSingleFlight } from "../singleFlight.js";
import { createEdgeLogger } from "./edgeLog.js";
import {
  getOAuthToken,
  getOAuthUsage,
  mapOAuthUsage,
  type OAuthToken,
  type OAuthUsageRaw,
  readAccountIdentity,
} from "./oauthUsage.js";

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

/**
 * Categorizes a failure so the UI can offer the right remedy instead of
 * always telling the user to re-enter their key.
 *
 * - `unauthorized` / `no_org` are *credential* problems — reconfiguring helps.
 * - `rate_limited` / `unavailable` are *transient* problems — the key is fine,
 *   retrying later helps. Telling the user to reconfigure here sends them in a
 *   loop (re-entering a correct key cannot fix a rate limit or an outage).
 */
export type ErrorKind =
  | "unauthorized"
  | "no_org"
  | "rate_limited"
  | "unavailable"
  | "stale_token";

export interface RateLimitData {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  sevenDaySonnet: RateLimitWindow | null;
  sevenDayOpus: RateLimitWindow | null;
  extraUsage: ExtraUsage | null;
  account: AccountInfo;
  fetchedAt: string;
  error?: string;
  /** Failure category for the error, when `error` is set. Lets the dashboard
   * distinguish a bad credential from a transient outage. */
  errorKind?: ErrorKind;
  /** Where the active credential came from (`oauth` = Claude Code's read-only
   * login token, the zero-touch default). Undefined when none is configured. */
  credentialSource?: CredentialSource;
  /** True when no usage credential is available anywhere */
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

/**
 * In-memory cache. Both `cached` and `lastGood` are tagged with a fingerprint
 * of the session key that produced them (`fp`). Reads only accept an entry
 * whose `fp` matches the current key, so a key change can never be served the
 * previous key's data — even if a concurrent poll repopulated the cache in the
 * window between a settings write and the follow-up validation read. This makes
 * correctness local to the scanner rather than dependent on callers remembering
 * to call `invalidateCache()`.
 */
let cached: { data: RateLimitData; expiresAt: number; fp: string } | null =
  null;
let lastGood: { data: RateLimitData; fp: string } | null = null;
// 180s base TTL: the OAuth usage endpoint is shared with Claude Code itself, so
// a generous cache keeps the dashboard's polling well clear of a 429.
const CACHE_TTL = 180_000;
const CACHE_TTL_429 = 5 * 60_000;

/** Cached org ID, tagged with the fingerprint of the cookie that resolved it.
 * The tag matters on a key change: an in-flight bootstrap from the OLD key can
 * land after invalidateCache() and would otherwise repopulate this with the
 * old account's org — making the NEW key's very first read query the wrong
 * org, 403, and report a valid key as "expired" (in the one read the user is
 * watching after a paste). */
let cachedOrgId: { orgId: string; fp: string } | null = null;

/**
 * Dev/QA usage override. When set, {@link getRateLimits} returns this snapshot
 * verbatim instead of querying claude.ai — letting the usage-queue feature be
 * demoed (capped → cleared) without actually hitting a real limit. Set only via
 * the `/api/usage-queue/_simulate` endpoint, which is itself gated behind the
 * `AUTONOMOS_ENABLE_USAGE_SIMULATION` env flag (off in normal/prod runs). Pass
 * null to clear and resume real usage reads.
 */
let usageOverride: RateLimitData | null = null;

/** Consecutive polls on which the OAuth token was unreadable/absent — see the
 * debounce in {@link getRateLimits}. Reset on any successful token read. */
let oauthMissingStreak = 0;

/** Which source the last getRateLimits answer actually came from. The
 * missing-login debounce only applies while this is "oauth": that is the only
 * state an account-flap can start from. A fresh boot or a key-only setup
 * (nothing served yet, or already on the key) falls back immediately. */
let lastServedSource: "oauth" | "manual" | null = null;

/** Force a scripted usage snapshot (or null to clear). Dev/QA only — see
 * {@link usageOverride}. */
export function setUsageOverride(data: RateLimitData | null): void {
  usageOverride = data;
}

/** The active usage override, or null when reading real usage. */
export function getUsageOverride(): RateLimitData | null {
  return usageOverride;
}

/** Short, non-reversible fingerprint of a cookie, to key cache entries to a
 * session key without retaining a second copy of the raw secret. */
function fingerprint(cookie: string): string {
  return createHash("sha256").update(cookie).digest("hex").slice(0, 16);
}

/**
 * Where the active usage credential came from.
 *
 * - `settings` — an explicit manual claude.ai session-key paste.
 * - `env` — an explicit `CLAUDE_SESSION_KEY` override.
 * - `oauth` — the zero-touch default: Claude Code's read-only OAuth token (env
 *   `CLAUDE_CODE_OAUTH_TOKEN`, macOS keychain, or `~/.claude/.credentials.json`).
 *   See {@link ./oauthUsage}.
 */
export type CredentialSource = "settings" | "env" | "oauth";

/**
 * Resolve the MANUAL claude.ai session key and where it came from, in priority
 * order. This handles only the explicit override path — OAuth (the zero-touch
 * default) is resolved separately in {@link getRateLimits}.
 *   1. `settings.claudeSessionKey` — an explicit manual paste.
 *   2. `CLAUDE_SESSION_KEY` — an explicit env override.
 *
 * Exported for tests.
 */
export function resolveSessionKey(): {
  key: string;
  source: CredentialSource;
} | null {
  const settings = getSettings();
  const fromSettings = settings.claudeSessionKey?.trim();
  if (fromSettings) return { key: fromSettings, source: "settings" };
  const fromEnv = process.env.CLAUDE_SESSION_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  return null;
}

/** The source of the active manual credential, or null if none is configured.
 * Does not report `oauth` (resolved separately). */
export function getCredentialSource(): CredentialSource | null {
  return resolveSessionKey()?.source ?? null;
}

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
  const resolved = resolveSessionKey();
  return resolved ? `sessionKey=${resolved.key}` : null;
}

/** Clear cached data — call after settings change */
export function invalidateCache(): void {
  cached = null;
  cachedOrgId = null;
  lastGood = null;
  oauthMissingStreak = 0;
  lastServedSource = null;
}

/** Test hook: expire the cached entry while KEEPING lastGood, so tests can
 * exercise the serve-stale-marked path without mocking the clock. */
export function __expireCacheForTests(): void {
  if (cached) cached.expiresAt = 0;
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

/** Membership shape we read from the bootstrap response. */
type Membership = {
  organization?: { uuid?: string; capabilities?: string[] };
};

/**
 * Pick the organization whose usage we should query.
 *
 * The `/usage` endpoint is only authorized for the org with claude.ai access
 * — the one carrying the `chat` capability (the Pro/Max subscription). A user
 * who has *also* used the Anthropic API has a separate `api`-capability org
 * that 403s on `/usage`, and bootstrap frequently lists THAT org first. So
 * blindly taking `memberships[0]` (the prior behavior) queried the wrong org
 * for every such account — a valid key that could never load usage. Prefer the
 * chat/claude_max org; fall back to the sole membership only when no capability
 * signal is present, preserving behavior for single-org accounts.
 *
 * Exported for tests.
 */
export function selectUsageOrg(memberships: Membership[]): string | null {
  const orgs = memberships
    .map((m) => m.organization)
    .filter((o): o is NonNullable<typeof o> => !!o);
  const withCap = (cap: string) =>
    orgs.find((o) => o.capabilities?.includes(cap));
  const chat = withCap("chat") ?? withCap("claude_max");
  if (chat?.uuid) return chat.uuid;
  // Sole-org fallback, but only when the org gives NO capability signal —
  // bootstrap sometimes omits capabilities for single-org accounts, and the
  // org is the only candidate. If the lone org *explicitly* advertises
  // capabilities that exclude claude.ai access (e.g. an API-only account), do
  // NOT return it: `/usage` would 403 and surface as a misleading "expired
  // key" error. Returning null routes to the accurate no-subscription message.
  if (orgs.length === 1 && !orgs[0].capabilities?.length) {
    return orgs[0].uuid ?? null;
  }
  return null;
}

const bootstrapFetchLog = createEdgeLogger("[claude-usage] bootstrap");

/**
 * Resolve the organization UUID for the given cookie.
 *
 * The session-key-only cookie carries no `lastActiveOrg`, so resolution
 * falls through to the bootstrap API. A manually-supplied full cookie
 * string that still contains `lastActiveOrg` is honored as a shortcut.
 * Result is cached. Exported for tests.
 *
 * Distinguishes the failure modes (`unauthorized` for an expired/invalid
 * key, `no_org` for a valid key with no claude.ai-capable organization, see
 * {@link selectUsageOrg}, `error` for network/parse problems) so the caller
 * can surface an actionable message.
 */
export async function fetchOrgId(
  cookie: string,
  fetcher: UsageFetcher = defaultFetcher,
): Promise<OrgIdResult> {
  const fp = fingerprint(cookie);
  if (cachedOrgId && cachedOrgId.fp === fp) {
    return { orgId: cachedOrgId.orgId, status: "ok" };
  }

  // Honor an explicit lastActiveOrg if present (manual full-cookie paste).
  const orgMatch = cookie.match(/lastActiveOrg=([^;]+)/);
  if (orgMatch) {
    cachedOrgId = { orgId: orgMatch[1], fp };
    return { orgId: orgMatch[1], status: "ok" };
  }

  // Resolve from the bootstrap API using the session key alone. Same edge
  // semantics as fetchUsageData below: success() on any completed exchange,
  // failure() only on a throw — an offline host with a manual session key
  // retries bootstrap every poll (cachedOrgId never populates), which was the
  // audit's per-poll stack spam on the credential path it didn't exercise.
  try {
    const result = await (async (): Promise<OrgIdResult> => {
      const res = await fetcher(BOOTSTRAP_URL, {
        headers: { Cookie: buildCookieHeader(cookie) },
      });
      if (res.status === 401 || res.status === 403) {
        return { orgId: null, status: "unauthorized" };
      }
      if (!res.ok) return { orgId: null, status: "error" };
      const data = (await res.json()) as {
        account?: {
          memberships?: Array<{
            organization?: { uuid?: string; capabilities?: string[] };
          }>;
        };
      };
      const memberships = data?.account?.memberships ?? [];
      const orgId = selectUsageOrg(memberships);
      if (!orgId) {
        // No usable org. Two shapes land here: an expired cookie (bootstrap
        // treats it as logged-out → empty memberships) vs. a valid key whose
        // only orgs lack claude.ai access (e.g. an API-only account). Log the
        // shape (never the cookie) so they're tellable apart from server logs.
        console.warn(
          `[claude-usage] bootstrap resolved no usable org (account=${!!data?.account}, memberships=${
            Array.isArray(data?.account?.memberships)
              ? `[${memberships.length}; caps=${memberships
                  .map((m) => (m.organization?.capabilities ?? []).join("|"))
                  .join(",")}]`
              : typeof data?.account?.memberships
          })`,
        );
        return { orgId: null, status: "no_org" };
      }
      cachedOrgId = { orgId, fp };
      return { orgId, status: "ok" };
    })();
    bootstrapFetchLog.success();
    return result;
  } catch (err) {
    bootstrapFetchLog.failure(err);
    return { orgId: null, status: "error" };
  }
}

type UsageStatus = "ok" | "rate_limited" | "unauthorized" | "error";

interface UsageResult {
  data: Record<string, unknown> | null;
  status: UsageStatus;
}

const usageFetchLog = createEdgeLogger("[claude-usage] usage fetch");

async function fetchUsageData(
  cookie: string,
  orgId: string,
  fetcher: UsageFetcher = defaultFetcher,
): Promise<UsageResult> {
  // Edge semantics: the logger tracks TRANSPORT health, so ANY completed
  // HTTP exchange counts as healthy — including 429/401/!ok, which surface
  // through their own UsageStatus channel. Two traps this shape avoids:
  //  - success() only on the fully-ok path wedges the edge at `failing`
  //    through e.g. an expired-credential period, silencing a later DISTINCT
  //    outage forever;
  //  - success() BEFORE the body parse flips the edge every poll on a
  //    persistent malformed-200 (captive portal), re-logging each cycle.
  // So: success() fires exactly when the try block completes without
  // throwing; a body-parse failure is a failure.
  try {
    const result = await (async (): Promise<UsageResult> => {
      const res = await fetcher(`${USAGE_URL}/${orgId}/usage`, {
        headers: { Cookie: buildCookieHeader(cookie) },
      });
      if (res.status === 429) return { data: null, status: "rate_limited" };
      if (res.status === 401 || res.status === 403) {
        cachedOrgId = null;
        return { data: null, status: "unauthorized" };
      }
      if (!res.ok) return { data: null, status: "error" };
      const data = (await res.json()) as Record<string, unknown>;
      return { data, status: "ok" };
    })();
    usageFetchLog.success();
    return result;
  } catch (err) {
    // Edge-triggered: an offline host polls right through — one line on the
    // first failure, one on recovery, no per-poll transport stacks.
    usageFetchLog.failure(err);
    return { data: null, status: "error" };
  }
}

export async function getRateLimits(
  fetcher: UsageFetcher = defaultFetcher,
): Promise<RateLimitData> {
  // Dev/QA: a simulated snapshot short-circuits the real query (see
  // {@link usageOverride}). This is what makes the usage-queue feature
  // demoable without burning a real limit.
  if (usageOverride) return usageOverride;

  const resolved = resolveSessionKey();

  // The auto-detect toggle SELECTS the credential source — it is not just a
  // gate on the OAuth fallback. ON → Claude Code's login (OAuth) is
  // authoritative, and a saved manual key serves only as a fallback when the
  // OAuth credential itself is broken. OFF → the manual key is authoritative.
  // (Previously a saved key always won, which made turning auto-detect ON a
  // silent no-op forever after a key had been pasted — exactly the trap hit
  // when switching Claude accounts. Pasting a key now turns auto-detect OFF
  // client-side, so each action states its intent.)
  let fallbackNote: { error: string; errorKind: ErrorKind } | undefined;
  if (isAutoDetectAccountEnabled(getSettings())) {
    const oauth = await computeOAuthRateLimits();
    // needsSetup cannot distinguish "no Claude Code login" from "couldn't READ
    // the login this instant" — the token readers return null on a locked
    // keychain, the 1s `security` timeout, or a read racing `claude`'s own
    // rewrite of .credentials.json. While OAuth is the ACTIVE source, a single
    // miss must therefore not switch to the key (it would flash a different
    // account's numbers and flap back on the next poll) — absence has to be
    // observed twice in a row. When OAuth was NOT serving (fresh boot,
    // key-only setup), there is nothing to flap from and the fallback is
    // immediate, as before.
    if (oauth.needsSetup === true) oauthMissingStreak += 1;
    else oauthMissingStreak = 0;
    const missingConfirmed =
      oauth.needsSetup === true &&
      (lastServedSource !== "oauth" || oauthMissingStreak >= 2);
    const credentialFailure =
      missingConfirmed ||
      oauth.errorKind === "stale_token" ||
      oauth.errorKind === "unauthorized";
    // Falling through means the OAuth credential is unusable AND a manual key
    // exists — use it so usage keeps tracking. Transient failures (429/outage)
    // deliberately do NOT fall back: flapping between two accounts' numbers is
    // worse than a short delay.
    if (!credentialFailure || !resolved) {
      if (oauth.needsSetup !== true) lastServedSource = "oauth";
      return oauth;
    }
    // A BROKEN login (stale/rejected) must ride along as a marker, or the user
    // never learns it while the manual key keeps the numbers green. A machine
    // with NO login at all (needsSetup) falls back silently — that is the
    // normal key-only setup, not a fault to nag about.
    if (
      oauth.errorKind === "stale_token" ||
      oauth.errorKind === "unauthorized"
    ) {
      fallbackNote = {
        error:
          oauth.errorKind === "stale_token"
            ? "Claude Code login expired — showing usage from your saved session key."
            : "Claude Code login was rejected — showing usage from your saved session key.",
        errorKind: oauth.errorKind,
      };
    }
  } else if (!resolved) {
    return {
      ...errorResult(
        "Auto-detect is off and no session key is saved. Turn auto-detect on, or paste a claude.ai session key.",
      ),
      needsSetup: true,
    };
  }

  // Manual key: authoritative with auto-detect off, fallback with it on. When
  // the key ITSELF failed, its own error is the actionable one — don't
  // overwrite it with the fallback note.
  const data = await computeRateLimits(`sessionKey=${resolved.key}`, fetcher);
  lastServedSource = "manual";
  if (fallbackNote && !data.error) {
    return { ...data, credentialSource: resolved.source, ...fallbackNote };
  }
  return { ...data, credentialSource: resolved.source };
}

/** De-dupe concurrent cache-missing reads (see {@link createSingleFlight}).
 * Keyed by credential fingerprint AND flow, so the OAuth and cookie paths never
 * share a flight even for an identically-fingerprinted credential. */
const singleFlight = createSingleFlight<RateLimitData>();

/** The cache entry for this credential, if it exists and is still fresh. The
 * fingerprint match is what stops a just-replaced key from reading the previous
 * account's numbers. */
function cachedFor(fp: string): RateLimitData | null {
  if (cached && cached.expiresAt > Date.now() && cached.fp === fp)
    return cached.data;
  return null;
}

/**
 * OAuth usage path. Reads Claude Code's local token (read-only, never
 * refreshed), calls the OAuth usage endpoint, and maps the result. Caches by a
 * fingerprint of the access token so an account switch (new token) misses cache.
 */
async function computeOAuthRateLimits(): Promise<RateLimitData> {
  const token = getOAuthToken();
  if (!token) {
    return {
      ...errorResult(
        "No Claude Code login found. Log in with `claude` (or paste a session key) to track usage.",
      ),
      needsSetup: true,
    };
  }

  const fp = fingerprint(token.accessToken);
  return (
    cachedFor(fp) ??
    singleFlight(`oauth:${fp}`, () => fetchOAuthRateLimits(token, fp))
  );
}

async function fetchOAuthRateLimits(
  token: OAuthToken,
  fp: string,
): Promise<RateLimitData> {
  const now = Date.now();
  // Re-check under the flight: a caller that queued behind a completed flight
  // (promise settled between its cache miss and joining) reads the fresh cache.
  const hit = cachedFor(fp);
  if (hit) return hit;

  // Reuse the token already read above — getOAuthUsage must not re-read the
  // keychain/file (double blocking sync read) nor risk fetching with a token
  // that differs from the one the cache fingerprint was computed from.
  const result = await getOAuthUsage(token);

  if (result.status === "stale") {
    return {
      ...errorResult(
        "Your Claude Code login token has expired. Run a Claude Code session to refresh it, or paste a session key.",
        "stale_token",
      ),
      credentialSource: "oauth",
    };
  }
  if (result.status === "unauthorized") {
    return {
      ...errorResult(
        "Claude rejected the Claude Code login token. Run a Claude Code session to refresh it, or paste a session key.",
        "unauthorized",
      ),
      credentialSource: "oauth",
    };
  }
  if (result.status === "rate_limited") {
    // Back off: the OAuth usage endpoint is shared with Claude Code itself, so
    // re-hitting it every poll worsens the limit. Cache the rate-limited state
    // for CACHE_TTL_429 so subsequent reads short-circuit. Serve last-good for
    // this token if we have it; otherwise cache the error result itself.
    if (lastGood && lastGood.fp === fp) {
      const stale = staleServed(lastGood.data, "rate_limited");
      cached = { data: stale, expiresAt: now + CACHE_TTL_429, fp };
      return stale;
    }
    const errored: RateLimitData = {
      ...errorResult(
        "Anthropic is rate-limiting usage requests right now. Your login is fine — this clears on its own in a few minutes.",
        "rate_limited",
      ),
      credentialSource: "oauth",
    };
    cached = { data: errored, expiresAt: now + CACHE_TTL_429, fp };
    return errored;
  }
  if (result.status === "unavailable") {
    // Serve last-good for the SAME token if we have it, so a transient blip
    // doesn't blank the panel; otherwise report the transient failure.
    if (lastGood && lastGood.fp === fp) {
      const stale = staleServed(lastGood.data, "unavailable");
      cached = { data: stale, expiresAt: now + CACHE_TTL, fp };
      return stale;
    }
    return {
      ...errorResult(
        "Anthropic's usage API is temporarily unavailable. Your login is fine — retry in a moment.",
        "unavailable",
      ),
      credentialSource: "oauth",
    };
  }

  // Account display is email · plan. The plan rides on the OAuth token; the
  // email comes from ~/.claude.json. The org UUID is intentionally NOT shown.
  const identity = readAccountIdentity();
  const data: RateLimitData = {
    ...mapOAuthUsage(result.data),
    account: {
      email: identity?.email,
      subscriptionType: token.subscriptionType,
    },
    fetchedAt: new Date().toISOString(),
    credentialSource: "oauth",
  };

  lastGood = { data, fp };
  cached = { data, expiresAt: now + CACHE_TTL, fp };
  return data;
}

async function computeRateLimits(
  cookie: string,
  fetcher: UsageFetcher = defaultFetcher,
): Promise<RateLimitData> {
  // The cookie is matched to the cache by fingerprint — a cache entry built
  // under a different (e.g. just-replaced) key is ignored.
  const fp = fingerprint(cookie);
  return (
    cachedFor(fp) ??
    singleFlight(`cookie:${fp}`, () =>
      fetchCookieRateLimits(cookie, fp, fetcher),
    )
  );
}

async function fetchCookieRateLimits(
  cookie: string,
  fp: string,
  fetcher: UsageFetcher,
): Promise<RateLimitData> {
  const now = Date.now();
  // Re-check under the flight (see fetchOAuthRateLimits).
  const hit = cachedFor(fp);
  if (hit) return hit;

  const org = await fetchOrgId(cookie, fetcher);
  if (org.status === "unauthorized") {
    return errorResult(
      "Session key expired or invalid. Open claude.ai, copy a fresh sessionKey cookie, and re-enter it.",
      "unauthorized",
    );
  }
  if (org.status === "no_org") {
    // `no_org` now has two causes (see selectUsageOrg): an empty membership
    // list — bootstrap treats an expired/unrecognized cookie as logged-out —
    // OR a valid key whose orgs lack claude.ai access (an API-only account
    // with no Pro/Max subscription). The message names both so a valid-key
    // user isn't wrongly told their key expired.
    return errorResult(
      "No Claude usage found for this session key. Either the key is expired, or this account has no Claude Pro/Max subscription (usage tracking needs a claude.ai plan, not just API access). If you have a plan, copy a fresh sessionKey from claude.ai and re-enter it.",
      "no_org",
    );
  }
  if (!org.orgId) {
    // org.status === "error": a network or parse failure resolving the org,
    // not a credential problem — retrying is the right remedy.
    return errorResult(
      "Couldn't reach claude.ai to verify your account. This is usually temporary — retry in a moment.",
      "unavailable",
    );
  }

  const { data: body, status } = await fetchUsageData(
    cookie,
    org.orgId,
    fetcher,
  );

  if (status === "unauthorized") {
    return errorResult(
      "Session key expired or invalid. Open claude.ai, copy a fresh sessionKey cookie, and re-enter it.",
      "unauthorized",
    );
  }

  if (!body) {
    const ttl = status === "rate_limited" ? CACHE_TTL_429 : CACHE_TTL;
    // Only serve stale data that belongs to the *current* key. Without the
    // fingerprint check, a transient failure right after a key change would
    // serve the previous key's numbers as if the new key worked.
    if (lastGood && lastGood.fp === fp) {
      const stale = staleServed(
        lastGood.data,
        status === "rate_limited" ? "rate_limited" : "unavailable",
      );
      cached = { data: stale, expiresAt: now + ttl, fp };
      return stale;
    }
    return status === "rate_limited"
      ? errorResult(
          "claude.ai is rate-limiting usage requests right now. Your key is fine — this clears on its own in a few minutes.",
          "rate_limited",
        )
      : errorResult(
          "claude.ai's usage API is temporarily unavailable. Your key is fine — retry in a moment.",
          "unavailable",
        );
  }

  // The claude.ai /usage body has the same shape as the OAuth usage response
  // (five_hour / seven_day / seven_day_sonnet / seven_day_opus / extra_usage),
  // so the mapping is shared with the OAuth path (see oauthUsage.mapOAuthUsage).
  const data: RateLimitData = {
    ...mapOAuthUsage(body as unknown as OAuthUsageRaw),
    account: {},
    fetchedAt: new Date().toISOString(),
  };

  lastGood = { data, fp };
  cached = { data, expiresAt: now + CACHE_TTL, fp };
  return data;
}

/**
 * A last-good snapshot re-served during a transient upstream failure, MARKED as
 * such. Previously the stale copy was served verbatim — indistinguishable from
 * live data, indefinitely (each failing cycle re-cached it with no maximum
 * age). The numbers stay (better than blanking the bar) but `error`/`errorKind`
 * now ride along so the UI can render them with an honest "delayed" marker.
 * `fetchedAt` is NOT restamped — it keeps reporting when the numbers were
 * actually fetched.
 */
function staleServed(
  data: RateLimitData,
  kind: "rate_limited" | "unavailable",
): RateLimitData {
  return {
    ...data,
    error:
      kind === "rate_limited"
        ? "Usage requests are being rate-limited — showing the last successful reading."
        : "The usage API is unreachable — showing the last successful reading.",
    errorKind: kind,
  };
}

function errorResult(error: string, errorKind?: ErrorKind): RateLimitData {
  return {
    fiveHour: null,
    sevenDay: null,
    sevenDaySonnet: null,
    sevenDayOpus: null,
    extraUsage: null,
    account: {},
    fetchedAt: new Date().toISOString(),
    error,
    errorKind,
  };
}
