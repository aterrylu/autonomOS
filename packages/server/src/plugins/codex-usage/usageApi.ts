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

import { limitDescription, limitDisplayName, limitId } from "./limitLabels.js";
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

/** Every numeric field may arrive as a numeric STRING — the endpoint started
 *  stringifying `credits.balance` on the 2026 Pro plans and the same
 *  serializer produces the windows, so all three go through {@link parseNumber}. */
type RawNumber = number | string | null;

interface RawWindow {
  used_percent?: RawNumber;
  reset_at?: RawNumber; // epoch seconds
  limit_window_seconds?: RawNumber;
}

interface RawRateLimit {
  primary_window?: RawWindow | null;
  secondary_window?: RawWindow | null;
}

interface RawAdditionalLimit {
  limit_name?: string | null;
  metered_feature?: string | null;
  rate_limit?: RawRateLimit | null;
  /** The ordinary model a reserve lane stands in for ("gpt-5.6-luna"). */
  normal_model_slug?: string | null;
}

interface RawCredits {
  has_credits?: boolean;
  unlimited?: boolean;
  /** Numeric, or a numeric STRING — the endpoint started sending `"0"` on the
   *  2026 Pro plans (codexbar decodes both, CreditDetails). */
  balance?: RawNumber;
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
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = parseNumber(raw.used_percent);
  if (usedPercent === null) {
    // A window object is PRESENT but its utilization isn't a number — that
    // drops a lane (or hides the whole bar), so say so once rather than
    // silently. Lossy stays lossy; it just stops being invisible.
    warnOnce(
      `window used_percent unparseable: ${JSON.stringify(raw.used_percent)}`,
    );
    return null;
  }
  const seconds = parseNumber(raw.limit_window_seconds);
  const windowMinutes = seconds === null ? 0 : Math.round(seconds / 60);
  const resetAt = parseNumber(raw.reset_at);
  const resetsAt =
    resetAt === null ? null : new Date(resetAt * 1000).toISOString();
  return { usedPercent, windowMinutes, resetsAt };
}

/** Raw values already warned about this process — the endpoint is polled
 *  every minute, so a persistent oddity would otherwise log every poll. */
const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[codex-usage] ${message}`);
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
    balance: parseBalance(raw.balance),
  };
}

/** Balance: parsed like any other number, but an unparseable NON-empty value
 *  is logged once — with `has_credits: true` the panel then shows "Available"
 *  and the user can't otherwise tell the figure was dropped. */
function parseBalance(raw: RawNumber | undefined): number | null {
  const n = parseNumber(raw);
  if (n === null && typeof raw === "string" && raw.trim() !== "") {
    warnOnce(`credit balance unparseable: ${JSON.stringify(raw)}`);
  }
  return n;
}

/** A finite number, or a non-empty string that parses to one; anything else
 *  (null, "", "abc", booleans, objects) → null. Exported for tests. */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Map the per-model `additional_rate_limits[]`. Lossy per element: a malformed
 *  entry is skipped, never throwing away its valid siblings. Entries with no
 *  usable window on either side are dropped (nothing to render). Names go
 *  through {@link limitDisplayName}: known lanes get the Codex CLI's wording,
 *  UNKNOWN lanes are prettified and kept — never dropped (see limitLabels.ts).
 *  Ids are de-duplicated with a numeric suffix rather than dropping the later
 *  entry, so two lanes sharing a metered feature both still render. */
function mapAdditionalLimits(
  raw: RawAdditionalLimit[] | null | undefined,
): CodexNamedLimit[] {
  if (!Array.isArray(raw)) return [];
  const out: CodexNamedLimit[] = [];
  const usedIds = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const primary = mapWindow(entry.rate_limit?.primary_window);
    const secondary = mapWindow(entry.rate_limit?.secondary_window);
    if (!primary && !secondary) continue;
    const identity = {
      limitName: entry.limit_name,
      meteredFeature: entry.metered_feature,
      normalModelSlug: entry.normal_model_slug,
    };
    const base = limitId(identity) ?? `codex-limit-${out.length + 1}`;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    out.push({
      id,
      name: limitDisplayName(identity),
      description: limitDescription(identity),
      meteredFeature:
        typeof entry.metered_feature === "string"
          ? entry.metered_feature.trim() || undefined
          : undefined,
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
