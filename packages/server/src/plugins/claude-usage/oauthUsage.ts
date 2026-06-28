/**
 * Claude usage via Claude Code's on-disk / keychain OAuth token (read-only).
 *
 * This is the zero-touch default credential path. autonomOS reads the OAuth
 * access token that Claude Code already manages locally and uses it — and only
 * it — to call Anthropic's OAuth usage endpoint. The token is NEVER refreshed
 * (refreshing rotates it and would break Claude Code's own login), NEVER written
 * to disk, and NEVER logged.
 *
 * Token source priority:
 *   1. env `CLAUDE_CODE_OAUTH_TOKEN` — an explicit long-lived override (CI etc.).
 *   2. macOS keychain — the account-keyed generic password `Claude Code-credentials`
 *      for the current `$USER`. The account-keyed entry is the FRESH one; the
 *      default (account-less) lookup returns a STALE legacy entry, so we always
 *      pass `-a $USER`.
 *   3. file `${CLAUDE_CONFIG_DIR or ~/.claude}/.credentials.json` (Linux/Windows).
 *
 * The keychain/file payload is JSON of the shape
 * `{ claudeAiOauth: { accessToken, expiresAt(epoch ms), subscriptionType } }`.
 * The access token has an ~8h TTL; once `expiresAt <= now` we treat it as STALE
 * and surface that to the user rather than refreshing it.
 */

import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtraUsage, RateLimitWindow } from "./scanner.js";

const execFileAsync = promisify(execFile);

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";
const FALLBACK_CLI_VERSION = "2.1.195";

/** Minimal HTTP response shape consumed by the OAuth usage fetcher. */
interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * HTTP fetcher seam. Defaults to the global `fetch`; tests inject a fake to
 * exercise the mapping deterministically without network access.
 */
export type OAuthFetcher = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<FetchResponse>;

const defaultFetcher: OAuthFetcher = (url, init) => fetch(url, init);

/** A resolved OAuth token plus where it came from. The raw token is never
 * logged; `source` is a coarse label safe to surface. */
export interface OAuthToken {
  accessToken: string;
  /** Epoch ms when the token expires. `Number.POSITIVE_INFINITY` for the env
   * override (no expiry metadata — treated as never-stale). */
  expiresAt: number;
  source: "env" | "keychain" | "file";
  /** Subscription tier from the credentials blob (e.g. "max"), best-effort. */
  subscriptionType?: string;
}

/** Token-reader seam — tests inject a fake so they never touch the keychain. */
export type OAuthTokenReader = () => OAuthToken | null;

/** The `claudeAiOauth` blob we read from the keychain / credentials file. */
interface ClaudeAiOauth {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/** Read the raw credentials JSON string from the macOS keychain, or null.
 * CRITICAL: `-a $USER` selects the fresh account-keyed entry; the account-less
 * lookup returns a stale legacy one. Never logs the value. */
function readKeychainCredentials(): string | null {
  if (process.platform !== "darwin") return null;
  const user = process.env.USER;
  if (!user) return null;
  try {
    // `timeout` guards the event loop: a normal `-w` lookup returns instantly,
    // but a locked keychain (or an unexpected GUI prompt) could otherwise hang
    // this synchronous call indefinitely. On timeout it throws → null → we fall
    // through to the file/env paths.
    const out = execFileSync(
      "security",
      [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-a",
        user,
        "-w",
      ],
      { encoding: "utf-8", timeout: 1_000 },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Read the raw credentials JSON string from the on-disk file, or null. */
function readFileCredentials(): string | null {
  try {
    const raw = readFileSync(
      join(claudeConfigDir(), ".credentials.json"),
      "utf-8",
    );
    return raw.trim() || null;
  } catch {
    return null;
  }
}

function parseClaudeAiOauth(raw: string): ClaudeAiOauth | null {
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: ClaudeAiOauth };
    const blob = parsed?.claudeAiOauth;
    return blob && typeof blob === "object" ? blob : null;
  } catch {
    return null;
  }
}

/** Resolve the on-disk OAuth credentials blob + which store produced it. */
function readCredentialsBlob(): {
  blob: ClaudeAiOauth;
  source: "keychain" | "file";
} | null {
  const fromKeychain = readKeychainCredentials();
  if (fromKeychain) {
    const blob = parseClaudeAiOauth(fromKeychain);
    if (blob) return { blob, source: "keychain" };
  }
  const fromFile = readFileCredentials();
  if (fromFile) {
    const blob = parseClaudeAiOauth(fromFile);
    if (blob) return { blob, source: "file" };
  }
  return null;
}

/**
 * Resolve the OAuth access token, read-only, in priority order. Returns null
 * when no token is available (→ the UI prompts the user to log in / paste a
 * key). Never logs the token.
 */
export function readOAuthToken(): OAuthToken | null {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) {
    return {
      accessToken: envToken,
      expiresAt: Number.POSITIVE_INFINITY,
      source: "env",
    };
  }
  const creds = readCredentialsBlob();
  if (creds?.blob.accessToken && typeof creds.blob.expiresAt === "number") {
    return {
      accessToken: creds.blob.accessToken,
      expiresAt: creds.blob.expiresAt,
      source: creds.source,
      subscriptionType: creds.blob.subscriptionType,
    };
  }
  return null;
}

/**
 * Best-effort account identity for display. Email + organization come from
 * Claude Code's `oauthAccount` block. NOTE the file is `.claude.json` and lives
 * at the HOME root (`~/.claude.json`) — a sibling of the `.claude/` dir, NOT
 * inside it (that dir holds `.credentials.json`). When `CLAUDE_CONFIG_DIR` is
 * set, CC relocates `.claude.json` under it, so we try that first, then the home
 * default. The plan (subscriptionType) rides on the OAuth token instead (see
 * {@link readOAuthToken}); this reads no credential store.
 */
export function readAccountIdentity(): {
  email?: string;
  organization?: string;
} | null {
  const candidates: string[] = [];
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (cfg) candidates.push(join(cfg, ".claude.json"));
  candidates.push(join(homedir(), ".claude.json"));
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        oauthAccount?: { emailAddress?: string; organizationUuid?: string };
      };
      const email = parsed?.oauthAccount?.emailAddress;
      const organization = parsed?.oauthAccount?.organizationUuid;
      if (email || organization) return { email, organization };
    } catch {
      /* absent or unreadable — try the next candidate */
    }
  }
  return null;
}

/** CLI version for the User-Agent. Cached after the first lookup. */
let cachedCliVersion: string | null = null;
async function claudeCliVersion(): Promise<string> {
  if (cachedCliVersion) return cachedCliVersion;
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      timeout: 5_000,
    });
    const m = stdout.match(/(\d+\.\d+\.\d+)/);
    cachedCliVersion = m?.[1] ?? FALLBACK_CLI_VERSION;
  } catch {
    cachedCliVersion = FALLBACK_CLI_VERSION;
  }
  return cachedCliVersion;
}

/** Raw shape of one usage window in the OAuth response. */
interface RawWindow {
  utilization?: number;
  resets_at?: string;
}

/** Raw OAuth usage response (codename fields beyond these are ignored). */
export interface OAuthUsageRaw {
  five_hour?: RawWindow | null;
  seven_day?: RawWindow | null;
  seven_day_opus?: RawWindow | null;
  seven_day_sonnet?: RawWindow | null;
  extra_usage?: {
    is_enabled?: boolean;
    monthly_limit?: number;
    used_credits?: number;
    utilization?: number | null;
  } | null;
}

/** Mapped usage windows — the subset of RateLimitData the OAuth path produces. */
export interface MappedUsage {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  sevenDaySonnet: RateLimitWindow | null;
  sevenDayOpus: RateLimitWindow | null;
  extraUsage: ExtraUsage | null;
}

function parseWindow(
  raw: RawWindow | null | undefined,
): RateLimitWindow | null {
  if (!raw || raw.utilization == null) return null;
  return { utilization: raw.utilization, resetsAt: raw.resets_at ?? "" };
}

/** Pure mapper: OAuth usage JSON → RateLimitData windows. Exported for tests. */
export function mapOAuthUsage(raw: OAuthUsageRaw): MappedUsage {
  const extra = raw.extra_usage ?? null;
  return {
    fiveHour: parseWindow(raw.five_hour),
    sevenDay: parseWindow(raw.seven_day),
    sevenDaySonnet: parseWindow(raw.seven_day_sonnet),
    sevenDayOpus: parseWindow(raw.seven_day_opus),
    extraUsage: extra?.is_enabled
      ? {
          isEnabled: true,
          monthlyLimit: extra.monthly_limit ?? 0,
          usedCredits: extra.used_credits ?? 0,
          utilization: extra.utilization ?? null,
        }
      : null,
  };
}

/**
 * Discriminated result of an OAuth usage fetch:
 *   - `ok`           — got usage JSON.
 *   - `stale`        — the token expired before we even called (we don't refresh).
 *   - `unauthorized` — endpoint returned 401 (token rejected).
 *   - `rate_limited` — endpoint returned 429 (back off; the token is fine).
 *   - `unavailable`  — no token, or a network / parse / non-2xx failure.
 */
export type OAuthUsageResult =
  | { status: "ok"; data: OAuthUsageRaw }
  | { status: "stale" }
  | { status: "unauthorized" }
  | { status: "rate_limited" }
  | { status: "unavailable" };

/**
 * Call the OAuth usage endpoint with the resolved token. Read-only: never
 * refreshes the token. Both the HTTP fetcher and the token reader are injectable
 * so tests stay off the network and the keychain.
 */
export async function fetchOAuthUsage(
  fetcher: OAuthFetcher = defaultFetcher,
  readToken: OAuthTokenReader = readOAuthToken,
): Promise<OAuthUsageResult> {
  const token = readToken();
  if (!token) return { status: "unavailable" };
  if (token.expiresAt <= Date.now()) return { status: "stale" };

  try {
    const version = await claudeCliVersion();
    const res = await fetcher(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": `claude-code/${version}`,
      },
    });
    if (res.status === 401) return { status: "unauthorized" };
    if (res.status === 429) return { status: "rate_limited" };
    if (!res.ok) return { status: "unavailable" };
    const data = (await res.json()) as OAuthUsageRaw;
    return { status: "ok", data };
  } catch (err) {
    // Network / parse failure — the message never contains the token.
    console.error("[claude-usage] OAuth usage fetch failed:", err);
    return { status: "unavailable" };
  }
}

// ── Test seams ────────────────────────────────────────────────
// Mirror scanner.ts's setUsageOverride: let a suite replace the real keychain
// reader and/or the network fetcher so exercising the OAuth path never depends
// on the host's live Claude Code login. null = use the real implementation.
let tokenReaderOverride: OAuthTokenReader | null = null;
let fetcherOverride: OAuthFetcher | null = null;

/** Inject a fake OAuth token reader (tests), or null to restore the real one. */
export function __setOAuthTokenReaderForTests(
  reader: OAuthTokenReader | null,
): void {
  tokenReaderOverride = reader;
}

/** Inject a fake OAuth HTTP fetcher (tests), or null to restore the real one. */
export function __setOAuthFetcherForTests(fetcher: OAuthFetcher | null): void {
  fetcherOverride = fetcher;
}

/** The active OAuth token reader (test override or the real reader). */
export function getOAuthToken(): OAuthToken | null {
  return (tokenReaderOverride ?? readOAuthToken)();
}

/**
 * Fetch usage through the active fetcher seam. Pass the already-resolved `token`
 * (from {@link getOAuthToken}) so the production path reads the keychain/file
 * exactly once and the fetch uses the same token the cache was fingerprinted
 * against (no double blocking read, no TOCTOU). Omit it only in standalone tests
 * that rely on the token-reader override.
 */
export function getOAuthUsage(token?: OAuthToken): Promise<OAuthUsageResult> {
  const readToken: OAuthTokenReader = token
    ? () => token
    : (tokenReaderOverride ?? readOAuthToken);
  return fetchOAuthUsage(fetcherOverride ?? defaultFetcher, readToken);
}
