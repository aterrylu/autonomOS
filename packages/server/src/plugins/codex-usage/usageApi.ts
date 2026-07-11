/**
 * Codex usage via the live ChatGPT-plan endpoint (read-only).
 *
 * This is the PRIMARY, real-time source. We read the Codex OAuth access token
 * read-only (see auth.ts) and call ChatGPT's usage endpoint — and only it. This
 * module issues exactly ONE request kind: `GET {base}/wham/usage`. It NEVER
 * POSTs, never touches auth.openai.com/oauth/token, and never writes auth.json
 * (ADR-048 — refreshing rotates the token and breaks the Codex CLI login). The
 * read-only-contract test asserts this by rejecting any non-GET / token-endpoint
 * call through the fetcher seam.
 *
 * The response mirrors what CodexBar decodes and what the rollout `token_count`
 * event persists: primary/secondary windows + credits + per-model
 * additional_rate_limits. Decoding is defensive/lossy — a malformed extra limit
 * can never discard the primary/secondary mapping.
 */

import type {
  CodexCredits,
  CodexNamedLimit,
  CodexUsageWindow,
} from "./types.js";

/** Usage path appended to the resolved ChatGPT backend base. */
const USAGE_PATH = "/wham/usage";

/** Minimal HTTP response shape consumed by the fetcher seam. */
interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** HTTP fetcher seam. Defaults to global `fetch`; tests inject a fake to
 *  exercise mapping + the read-only contract without network access. */
export type CodexUsageFetcher = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<FetchResponse>;

const defaultFetcher: CodexUsageFetcher = (url, init) => fetch(url, init);

// ── Raw response shape (snake_case, all optional — lossy by design) ──────────

interface RawWindow {
  used_percent?: number;
  reset_at?: number; // epoch seconds
  limit_window_seconds?: number;
}

interface RawRateLimit {
  primary_window?: RawWindow | null;
  secondary_window?: RawWindow | null;
}

interface RawAdditionalLimit {
  limit_name?: string;
  metered_feature?: string;
  rate_limit?: RawRateLimit | null;
}

interface RawCredits {
  has_credits?: boolean;
  unlimited?: boolean;
  balance?: number | null;
}

export interface CodexUsageRaw {
  plan_type?: string;
  rate_limit?: RawRateLimit | null;
  credits?: RawCredits | null;
  additional_rate_limits?: RawAdditionalLimit[] | null;
}

/** Mapped subset the usage endpoint produces (account identity is added by the
 *  scanner from the id_token). */
export interface MappedCodexUsage {
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  additionalLimits: CodexNamedLimit[];
  credits: CodexCredits | null;
  planType: string | null;
}

/** Normalize one raw window → the shared window shape. Null when the window is
 *  absent or carries no `used_percent` (nothing meaningful to show). */
export function mapWindow(
  raw: RawWindow | null | undefined,
): CodexUsageWindow | null {
  if (!raw || typeof raw.used_percent !== "number") return null;
  const windowMinutes =
    typeof raw.limit_window_seconds === "number"
      ? Math.round(raw.limit_window_seconds / 60)
      : 0;
  const resetsAt =
    typeof raw.reset_at === "number"
      ? new Date(raw.reset_at * 1000).toISOString()
      : null;
  return { usedPercent: raw.used_percent, windowMinutes, resetsAt };
}

/** Map raw credit fields → CodexCredits. Shared with the rollout scanner, whose
 *  on-disk credits object has the same shape. */
export function mapCredits(
  raw: RawCredits | null | undefined,
): CodexCredits | null {
  if (!raw) return null;
  return {
    hasCredits: raw.has_credits === true,
    unlimited: raw.unlimited === true,
    balance: typeof raw.balance === "number" ? raw.balance : null,
  };
}

/** Map the per-model `additional_rate_limits[]`. Lossy per element: a malformed
 *  entry is skipped, never throwing away its valid siblings. Entries with no
 *  usable window on either side are dropped (nothing to render). */
function mapAdditionalLimits(
  raw: RawAdditionalLimit[] | null | undefined,
): CodexNamedLimit[] {
  if (!Array.isArray(raw)) return [];
  const out: CodexNamedLimit[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const primary = mapWindow(entry.rate_limit?.primary_window);
    const secondary = mapWindow(entry.rate_limit?.secondary_window);
    if (!primary && !secondary) continue;
    const name =
      entry.limit_name?.trim() || entry.metered_feature?.trim() || "Limit";
    out.push({
      name,
      meteredFeature: entry.metered_feature,
      primary,
      secondary,
    });
  }
  return out;
}

/** Pure mapper: raw usage JSON → normalized windows. Exported for tests. */
export function mapCodexUsage(raw: CodexUsageRaw): MappedCodexUsage {
  return {
    primary: mapWindow(raw.rate_limit?.primary_window),
    secondary: mapWindow(raw.rate_limit?.secondary_window),
    additionalLimits: mapAdditionalLimits(raw.additional_rate_limits),
    credits: mapCredits(raw.credits),
    planType: typeof raw.plan_type === "string" ? raw.plan_type : null,
  };
}

/** Build the full usage URL from a resolved backend base. */
export function usageUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${USAGE_PATH}`;
}

/**
 * Discriminated result of a live usage fetch:
 *   - `ok`           — got usage JSON.
 *   - `unauthorized` — 401/403 (token rejected/expired server-side).
 *   - `rate_limited` — 429 (back off; the token is fine).
 *   - `unavailable`  — network / parse / other non-2xx failure.
 */
export type CodexUsageApiResult =
  | { status: "ok"; data: CodexUsageRaw }
  | { status: "unauthorized" }
  | { status: "rate_limited" }
  | { status: "unavailable" };

/**
 * Call `GET {base}/wham/usage` with the read-only access token. Read-only: the
 * only HTTP method issued is GET, and the only host is the configured ChatGPT
 * backend. Never refreshes the token.
 */
export async function fetchCodexUsage(
  accessToken: string,
  accountId: string | undefined,
  baseUrl: string,
  fetcher: CodexUsageFetcher = defaultFetcher,
): Promise<CodexUsageApiResult> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "User-Agent": "autonomOS",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  try {
    const res = await fetcher(usageUrl(baseUrl), { method: "GET", headers });
    if (res.status === 401 || res.status === 403)
      return { status: "unauthorized" };
    if (res.status === 429) return { status: "rate_limited" };
    if (!res.ok) return { status: "unavailable" };
    const data = (await res.json()) as CodexUsageRaw;
    return { status: "ok", data };
  } catch (err) {
    // Network / parse failure — the message never contains the token.
    console.error("[codex-usage] live usage fetch failed:", err);
    return { status: "unavailable" };
  }
}
