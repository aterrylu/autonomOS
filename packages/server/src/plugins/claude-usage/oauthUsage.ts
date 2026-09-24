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

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AuthHints, PlanHints } from "./credentialDiagnosis.js";
import { createEdgeLogger } from "./edgeLog.js";
import type {
  ExtraUsage,
  NamedRateWindow,
  RateLimitWindow,
  SpendLimit,
} from "./scanner.js";

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
export type OAuthTokenReader = () =>
  | OAuthToken
  | null
  | Promise<OAuthToken | null>;

/** The `claudeAiOauth` blob we read from the keychain / credentials file. */
interface ClaudeAiOauth {
  accessToken?: string;
  expiresAt?: number;
  subscriptionType?: string;
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/**
 * Why a credential store yielded no usable token. Kept structured (not
 * collapsed to null) so a diagnosis layer can explain an n/a usage bar — a
 * missing keychain item, a locked/denied keychain and a malformed credentials
 * file each need a different fix. Never contains the secret: stdout is only
 * kept on success, and stderr is the `security` tool's own diagnostic.
 */
export type CredentialReadFailure =
  | {
      source: "keychain";
      /** `security` exit code: 44 = item not found; 36/51 = user interaction
       * required / denied; 128 = cancelled. null when it never exited. */
      exitCode: number | null;
      signal: string | null;
      /** Spawn-level error code when `security` itself could not run or be
       * read (ENOENT = binary missing, ERR_CHILD_PROCESS_STDIO_MAXBUFFER, …). */
      errno: string | null;
      /** Trimmed, capped at {@link STDERR_CAP} chars. */
      stderr: string;
      /** Killed by our timeout — typically a locked keychain waiting on a prompt. */
      timedOut: boolean;
      /** `security` answered, but not with a usable `claudeAiOauth` blob. */
      parseFailed: boolean;
    }
  | {
      source: "file";
      /** fs error code (ENOENT, EACCES, …), or null when the file was read. */
      errno: string | null;
      /** The file was read but is not a usable `claudeAiOauth` blob. */
      parseFailed: boolean;
    };

const STDERR_CAP = 500;
const KEYCHAIN_TIMEOUT_MS = 1_000;
/** Hard ceiling on a keychain read. `execFile`'s timeout only SIGNALS the
 * child; if it never exits (stuck on a SecurityAgent prompt, a held pipe) the
 * promise would never settle — and single-flight would park every later usage
 * read behind it. This race guarantees the read always settles. */
const KEYCHAIN_DEADLINE_MS = 2 * KEYCHAIN_TIMEOUT_MS;

/** Keychain exec seam — tests inject a fake so they never touch the keychain. */
export type KeychainExec = (
  file: string,
  args: string[],
  opts: { timeout: number },
) => Promise<{ stdout: string }>;

const defaultKeychainExec: KeychainExec = (file, args, opts) =>
  execFileAsync(file, args, {
    encoding: "utf-8",
    timeout: opts.timeout,
    killSignal: "SIGKILL",
  });

let keychainExecOverride: KeychainExec | null = null;
let keychainDeadlineMs = KEYCHAIN_DEADLINE_MS;

const keychainFailure = (
  f: Partial<Extract<CredentialReadFailure, { source: "keychain" }>>,
): CredentialReadFailure => ({
  source: "keychain",
  exitCode: null,
  signal: null,
  errno: null,
  stderr: "",
  timedOut: false,
  parseFailed: false,
  ...f,
});

type RawRead =
  | { ok: true; raw: string }
  | { ok: false; failure: CredentialReadFailure | null };

/** Read the raw credentials JSON string from the macOS keychain.
 * CRITICAL: `-a $USER` selects the fresh account-keyed entry; the account-less
 * lookup returns a stale legacy one. Never logs the value.
 *
 * ASYNC on purpose: `execFileSync` from the server process blocked the event
 * loop for the whole spawn (~50-130ms measured — far longer than the lookup
 * itself), freezing every terminal stream on each usage poll. `execFile` pays
 * the same latency off the loop. `failure: null` = not applicable here (not
 * macOS / no $USER), as opposed to a real failure. */
async function readKeychainCredentials(): Promise<RawRead> {
  // An injected fake runs on any platform, so CI (Linux) exercises this path.
  if (process.platform !== "darwin" && !keychainExecOverride)
    return { ok: false, failure: null };
  const user = process.env.USER;
  if (!user) return { ok: false, failure: null };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const exec = (keychainExecOverride ?? defaultKeychainExec)(
      "security",
      [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-a",
        user,
        "-w",
      ],
      { timeout: KEYCHAIN_TIMEOUT_MS },
    );
    const outcome = await Promise.race([
      exec.then((r) => ({ stdout: r.stdout })),
      new Promise<"deadline">((resolve) => {
        deadline = setTimeout(() => resolve("deadline"), keychainDeadlineMs);
      }),
    ]);
    if (outcome === "deadline")
      return { ok: false, failure: keychainFailure({ timedOut: true }) };
    const raw = outcome.stdout.trim();
    return raw
      ? { ok: true, raw }
      : { ok: false, failure: keychainFailure({ exitCode: 0 }) };
  } catch (err) {
    const e = (err ?? {}) as {
      code?: unknown;
      signal?: unknown;
      stderr?: unknown;
      killed?: unknown;
    };
    return {
      ok: false,
      failure: keychainFailure({
        exitCode: typeof e.code === "number" ? e.code : null,
        errno: typeof e.code === "string" ? e.code : null,
        signal: typeof e.signal === "string" ? e.signal : null,
        stderr: String(e.stderr ?? "")
          .trim()
          .slice(0, STDERR_CAP),
        timedOut: e.killed === true,
      }),
    };
  } finally {
    clearTimeout(deadline);
  }
}

/** Read the raw credentials JSON string from the on-disk file. */
function readFileCredentials(): RawRead {
  try {
    const raw = readFileSync(
      join(claudeConfigDir(), ".credentials.json"),
      "utf-8",
    ).trim();
    return raw
      ? { ok: true, raw }
      : {
          ok: false,
          failure: { source: "file", errno: null, parseFailed: true },
        };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return {
      ok: false,
      failure: {
        source: "file",
        errno: typeof code === "string" ? code : null,
        parseFailed: false,
      },
    };
  }
}

/** Parse a credentials payload into a token, or null when it is not JSON, has
 * no `claudeAiOauth` blob, or the blob lacks a token / numeric expiry. */
function parseToken(
  raw: string,
  source: "keychain" | "file",
): OAuthToken | null {
  try {
    const blob = (JSON.parse(raw) as { claudeAiOauth?: ClaudeAiOauth })
      ?.claudeAiOauth;
    if (!blob?.accessToken || typeof blob.expiresAt !== "number") return null;
    return {
      accessToken: blob.accessToken,
      expiresAt: blob.expiresAt,
      source,
      subscriptionType: blob.subscriptionType,
    };
  } catch {
    return null;
  }
}

type TokenRead = {
  token: OAuthToken | null;
  failure: CredentialReadFailure | null;
};

/** Resolve the token read-only, in priority order, plus why it failed.
 * A keychain failure beats a file failure: on macOS the keychain is where the
 * login lives, and the file is only the Linux/Windows store. */
async function resolveToken(): Promise<TokenRead> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) {
    return {
      token: {
        accessToken: envToken,
        expiresAt: Number.POSITIVE_INFINITY,
        source: "env",
      },
      failure: null,
    };
  }

  const fromKeychain = await readKeychainCredentials();
  const keychainToken = fromKeychain.ok
    ? parseToken(fromKeychain.raw, "keychain")
    : null;
  if (keychainToken) return { token: keychainToken, failure: null };
  const keychainFail = fromKeychain.ok
    ? keychainFailure({ exitCode: 0, parseFailed: true })
    : fromKeychain.failure;

  const fromFile = readFileCredentials();
  const fileToken = fromFile.ok ? parseToken(fromFile.raw, "file") : null;
  if (fileToken) return { token: fileToken, failure: null };
  const fileFail: CredentialReadFailure = fromFile.ok
    ? { source: "file", errno: null, parseFailed: true }
    : (fromFile.failure ?? { source: "file", errno: null, parseFailed: false });

  return { token: null, failure: keychainFail ?? fileFail };
}

/** The last reason no store yielded a token — see {@link getLastCredentialFailure}. */
let lastCredentialFailure: CredentialReadFailure | null = null;

/**
 * Why the most recent credential read found no token, or null after a read
 * that found one (including the env override) or before any read. Read-only
 * diagnostics for explaining an n/a usage bar; never contains the secret.
 */
export function getLastCredentialFailure(): CredentialReadFailure | null {
  return lastCredentialFailure;
}

/**
 * Resolve the OAuth access token, read-only, in priority order:
 * env `CLAUDE_CODE_OAUTH_TOKEN` → macOS keychain → credentials file. Returns
 * null when no token is available (→ the UI prompts the user to log in / paste
 * a key). Never logs the token. Uncached — production reads go through
 * {@link getOAuthToken}, which memoizes this.
 */
export async function readOAuthToken(): Promise<OAuthToken | null> {
  const { token, failure } = await resolveToken();
  lastCredentialFailure = failure;
  return token;
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
    currency?: string | null;
  } | null;
  /** Newer fields, read only to DIAGNOSE a response with no rolling windows
   *  (spend-billed accounts) — not mapped to numbers. */
  spend?: {
    enabled?: boolean;
    used?: RawMoney | null;
    limit?: RawMoney | number | null;
    percent?: number | null;
    resets_at?: string | null;
  } | null;
  /** Newer list-shaped windows. For some accounts (a Team plan was the report)
   *  the flat fields above are null while this holds the real windows. */
  limits?: RawLimitEntry[] | null;
}

/** A money amount as the `spend` block spells it (minor units + exponent). */
export interface RawMoney {
  amount_minor?: number | null;
  currency?: string | null;
  exponent?: number | null;
}

/** One `limits[]` entry. All optional — decoded defensively. */
export interface RawLimitEntry {
  kind?: string | null;
  group?: string | null;
  percent?: number | string | null;
  resets_at?: string | null;
  scope?: {
    model?: { id?: string | null; display_name?: string | null } | null;
  } | null;
}

/** Mapped usage windows — the subset of RateLimitData the OAuth path produces. */
export interface MappedUsage {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  sevenDaySonnet: RateLimitWindow | null;
  sevenDayOpus: RateLimitWindow | null;
  extraWindows: NamedRateWindow[];
  extraUsage: ExtraUsage | null;
}

function parseWindow(
  raw: RawWindow | null | undefined,
): RateLimitWindow | null {
  if (!raw || typeof raw !== "object") return null;
  // Same number rule as limits[]: a non-numeric utilization is no window (it
  // would otherwise render "NaN%" and suppress the no-windows diagnosis).
  const utilization = limitPercent(raw.utilization);
  if (utilization === null) return null;
  return {
    utilization,
    resetsAt: typeof raw.resets_at === "string" ? raw.resets_at : "",
  };
}

const warnedLimits = new Set<string>();
function warnLimitsOnce(message: string): void {
  if (warnedLimits.has(message)) return;
  warnedLimits.add(message);
  console.warn(message);
}

/** Finite number from a number or numeric string, else null. */
function limitPercent(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function trimmedString(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw.trim() || undefined : undefined;
}

function limitSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "weekly_opus_extended" → "Weekly Opus Extended". */
function prettifyKind(kind: string): string {
  return kind
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Span suffix for an extra window's label, from its `group`. */
function groupSpan(group: string | undefined): string {
  if (group === "session") return "5h";
  if (group === "weekly") return "7d";
  return "";
}

/** A scope that names no single model ("All models") is the overall weekly. */
function isAllModels(name: string | undefined): boolean {
  return !name || /^all(\s+models)?$/i.test(name);
}

/** Which fixed slot a `limits[]` entry fills, or null for an extra window. */
type Slot = "fiveHour" | "sevenDay" | "sevenDaySonnet" | "sevenDayOpus";
function slotFor(kind: string, modelName: string | undefined): Slot | null {
  if (kind === "session") return "fiveHour";
  if (kind === "weekly_all") return "sevenDay";
  if (kind === "weekly_scoped") {
    if (isAllModels(modelName)) return "sevenDay";
    if (/\bsonnet\b/i.test(modelName ?? "")) return "sevenDaySonnet";
    if (/\bopus\b/i.test(modelName ?? "")) return "sevenDayOpus";
  }
  return null;
}

/**
 * Pure mapper: OAuth usage JSON → RateLimitData windows. Exported for tests.
 *
 * Two sources, merged per slot. The FLAT fields (`five_hour`, `seven_day`,
 * `seven_day_sonnet`, `seven_day_opus`) win when present — they are what every
 * account rendered before, so an account that has them is unchanged. The
 * `limits[]` list fills any slot the flat fields left null (the reported Team
 * account got null flat fields and real windows in `limits[]`), and every
 * entry that fits NO slot — a model-scoped weekly like "Fable", or a kind we
 * don't know yet — becomes a named extra window instead of being dropped.
 */
export function mapOAuthUsage(raw: OAuthUsageRaw): MappedUsage {
  const extra = raw.extra_usage ?? null;
  const slots: Record<Slot, RateLimitWindow | null> = {
    fiveHour: parseWindow(raw.five_hour),
    sevenDay: parseWindow(raw.seven_day),
    sevenDaySonnet: parseWindow(raw.seven_day_sonnet),
    sevenDayOpus: parseWindow(raw.seven_day_opus),
  };
  const extraWindows: NamedRateWindow[] = [];
  const seen = new Set<string>();
  // Slots a limits[] entry (not a flat field) filled — a SECOND entry for the
  // same slot is a different window (e.g. "Sonnet 4" and "Sonnet 4.5"), so it
  // is kept as a named window instead of being dropped.
  const filledFromLimits = new Set<Slot>();
  const skippedKinds: string[] = [];
  // Exact kinds (session / weekly_all) claim their slots before any scoped
  // entry can, so an unscoped "weekly_scoped" never takes the overall weekly
  // slot from the real weekly_all just by coming first in the array.
  const entries = Array.isArray(raw.limits) ? raw.limits : [];
  const exact = (e: unknown) =>
    !!e &&
    typeof e === "object" &&
    ["session", "weekly_all"].includes(
      trimmedString((e as RawLimitEntry).kind) ?? "",
    );
  for (const entry of [
    ...entries.filter(exact),
    ...entries.filter((e) => !exact(e)),
  ]) {
    if (!entry || typeof entry !== "object") {
      skippedKinds.push("(not an object)");
      continue;
    }
    const utilization = limitPercent(entry.percent);
    if (utilization === null) {
      skippedKinds.push(trimmedString(entry.kind) ?? "(no kind)");
      continue;
    }
    const window: RateLimitWindow = {
      utilization,
      resetsAt: trimmedString(entry.resets_at) ?? "",
    };
    const group = trimmedString(entry.group);
    const kind = trimmedString(entry.kind) ?? group ?? "limit";
    const modelName =
      trimmedString(entry.scope?.model?.display_name) ??
      trimmedString(entry.scope?.model?.id);
    const slot = slotFor(kind, modelName);
    if (slot && !slots[slot]) {
      slots[slot] = window;
      filledFromLimits.add(slot);
      continue;
    }
    // Filled by the flat field → the same window reported twice; skip it.
    if (slot && !filledFromLimits.has(slot)) continue;
    // Otherwise (no slot, or a second limits[] entry for a filled slot):
    // keep it as a named window.
    const span = groupSpan(group);
    const base =
      kind === "weekly_scoped" && modelName ? modelName : prettifyKind(kind);
    const label = span ? `${base} ${span}` : base;
    const spanField = span === "5h" || span === "7d" ? span : undefined;
    const baseId = `claude-${limitSlug(kind)}${modelName ? `-${limitSlug(modelName)}` : ""}`;
    let id = baseId;
    for (let n = 2; seen.has(id); n++) id = `${baseId}-${n}`;
    seen.add(id);
    extraWindows.push({
      ...window,
      id,
      label,
      ...(spanField ? { span: spanField } : {}),
    });
  }
  if (skippedKinds.length > 0) {
    // Lossy per entry by design, but never silent: once per distinct set.
    warnLimitsOnce(
      `[claude-usage] limits[]: skipped ${skippedKinds.length} unreadable entr${skippedKinds.length === 1 ? "y" : "ies"} (kinds: ${skippedKinds.join(", ")})`,
    );
  }
  return {
    ...slots,
    extraWindows,
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
 *   - `unavailable`  — no token, or a network / parse / non-2xx failure. `cause`
 *     and `httpStatus` say which, so the dashboard can name it (a 403 or a
 *     proxy's HTML page is not "Anthropic is down").
 */
export type OAuthUsageResult =
  | { status: "ok"; data: OAuthUsageRaw }
  | { status: "stale" }
  | { status: "unauthorized" }
  | { status: "rate_limited" }
  | {
      status: "unavailable";
      cause?: "network" | "http" | "parse";
      httpStatus?: number;
    };

/** A 2xx whose body wasn't JSON — told apart from a transport failure. */
class UsageBodyParseError extends Error {}

const oauthFetchLog = createEdgeLogger("[claude-usage] OAuth usage fetch");

/**
 * Call the OAuth usage endpoint with the resolved token. Read-only: never
 * refreshes the token. Both the HTTP fetcher and the token reader are injectable
 * so tests stay off the network and the keychain.
 */
export async function fetchOAuthUsage(
  fetcher: OAuthFetcher = defaultFetcher,
  readToken: OAuthTokenReader = readOAuthToken,
): Promise<OAuthUsageResult> {
  const token = await readToken();
  if (!token) return { status: "unavailable" };
  if (token.expiresAt <= Date.now()) return { status: "stale" };

  // Edge semantics mirror scanner.ts fetchUsageData: ANY completed HTTP
  // exchange counts as transport-healthy (401/429/!ok surface through their
  // own status channel), success() fires exactly on non-throw completion, a
  // body-parse failure is a failure.
  try {
    const result = await (async (): Promise<OAuthUsageResult> => {
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
      if (!res.ok)
        return { status: "unavailable", cause: "http", httpStatus: res.status };
      let data: OAuthUsageRaw;
      try {
        data = (await res.json()) as OAuthUsageRaw;
      } catch (err) {
        throw new UsageBodyParseError(
          `usage response was not JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Valid JSON but not an object (null / array / primitive) is not usage
      // data either — without this, mapOAuthUsage(null) throws out of the
      // poller and the route answers a bare 500 with no reason.
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new UsageBodyParseError(
          `usage response was ${data === null ? "null" : Array.isArray(data) ? "an array" : typeof data}, not an object`,
        );
      }
      return { status: "ok", data };
    })();
    oauthFetchLog.success();
    return result;
  } catch (err) {
    // Network / parse failure — the message never contains the token.
    // Edge-triggered: one line on the first failure, one on recovery.
    oauthFetchLog.failure(err);
    return {
      status: "unavailable",
      cause: err instanceof UsageBodyParseError ? "parse" : "network",
    };
  }
}

// ── Token memo ────────────────────────────────────────────────
// Every usage read needs the token only to fingerprint the cache, so re-reading
// the keychain per request spawned `security` on EVERY poll — including cache
// hits. The memo bounds that to one read per TTL. Read-only semantics are
// unchanged: this caches what Claude Code wrote, it never refreshes anything.
const TOKEN_MEMO_TTL_MS = 60_000;
/** Re-read interval for a token we know is unusable — none found, expired, or
 * rejected by the usage API — so a fixed or rotated login shows up quickly
 * without re-spawning `security` on every poll while it stays broken. Must stay
 * well under scanner.ts's OAUTH_MISS_CONFIRM_MS (30s) so a transient miss (a
 * `security` timeout, a mid-rewrite credentials file) is re-read before the
 * missing-login debounce could confirm it. */
const TOKEN_MISS_MEMO_TTL_MS = 10_000;
let tokenMemoTtlMs = TOKEN_MEMO_TTL_MS;
/** The memo's clock. Injectable so tests move time explicitly instead of
 * sleeping past real TTLs, which flaked under a loaded box. */
let memoClock: () => number = Date.now;
let tokenMissMemoTtlMs = TOKEN_MISS_MEMO_TTL_MS;

let tokenMemo: {
  token: OAuthToken | null;
  readAt: number;
  /** The usage API rejected this token (401). */
  rejected: boolean;
} | null = null;
/** Single-flight: concurrent polls (tabs + the usage-queue probe) share one read. */
let tokenRead: Promise<OAuthToken | null> | null = null;
/** Bumped by {@link invalidateOAuthTokenMemo} so a read that was in flight when
 * the memo was dropped cannot write its (possibly pre-invalidation) result or
 * failure back. */
let tokenMemoGeneration = 0;

function memoFresh(now: number): boolean {
  if (!tokenMemo) return false;
  const { token, readAt, rejected } = tokenMemo;
  const unusable = !token || rejected || token.expiresAt <= now;
  return now - readAt < (unusable ? tokenMissMemoTtlMs : tokenMemoTtlMs);
}

async function readOAuthTokenMemoized(): Promise<OAuthToken | null> {
  if (memoFresh(memoClock())) return tokenMemo?.token ?? null;
  if (tokenRead) return tokenRead;
  const generation = tokenMemoGeneration;
  const read = resolveToken()
    .then(({ token, failure }) => {
      if (generation === tokenMemoGeneration) {
        tokenMemo = { token, readAt: memoClock(), rejected: false };
        lastCredentialFailure = failure;
      }
      return token;
    })
    .finally(() => {
      if (tokenRead === read) tokenRead = null;
    });
  tokenRead = read;
  return read;
}

/** Drop the memoized token so the next read goes back to the keychain/file —
 * after an explicit settings change / cache invalidation. Also forgets the
 * last failure: it described the read being discarded. */
export function invalidateOAuthTokenMemo(): void {
  tokenMemo = null;
  lastCredentialFailure = null;
  tokenRead = null;
  tokenMemoGeneration += 1;
}

/** The usage API rejected the memoized token: re-read it within the miss TTL
 * (Claude Code may have rotated it) instead of serving it for the full hit
 * TTL — and without re-reading on every poll while it stays rejected. */
export function markOAuthTokenRejected(): void {
  if (tokenMemo)
    tokenMemo = { ...tokenMemo, rejected: true, readAt: memoClock() };
}

// ── Test seams ────────────────────────────────────────────────
// Mirror scanner.ts's setUsageOverride: let a suite replace the real keychain
// reader and/or the network fetcher so exercising the OAuth path never depends
// on the host's live Claude Code login. null = use the real implementation.
let tokenReaderOverride: OAuthTokenReader | null = null;
let fetcherOverride: OAuthFetcher | null = null;

/** Inject a fake OAuth token reader (tests), or null to restore the real one.
 * An injected reader bypasses the memo, so a suite's reader swap is seen on
 * the very next call. */
export function __setOAuthTokenReaderForTests(
  reader: OAuthTokenReader | null,
): void {
  tokenReaderOverride = reader;
  invalidateOAuthTokenMemo();
}

/** Inject a fake OAuth HTTP fetcher (tests), or null to restore the real one. */
export function __setOAuthFetcherForTests(fetcher: OAuthFetcher | null): void {
  fetcherOverride = fetcher;
}

/** Inject a fake `security` runner (tests) so the REAL reader + memo run
 * without touching the host keychain; null restores the real one. */
export function __setKeychainExecForTests(exec: KeychainExec | null): void {
  keychainExecOverride = exec;
  invalidateOAuthTokenMemo();
}

/** Shrink the memo TTLs / keychain deadline (tests); null restores defaults. */
export function __setTokenMemoTtlForTests(
  ttl: { hitMs: number; missMs: number; deadlineMs?: number } | null,
): void {
  tokenMemoTtlMs = ttl?.hitMs ?? TOKEN_MEMO_TTL_MS;
  tokenMissMemoTtlMs = ttl?.missMs ?? TOKEN_MISS_MEMO_TTL_MS;
  keychainDeadlineMs = ttl?.deadlineMs ?? KEYCHAIN_DEADLINE_MS;
  invalidateOAuthTokenMemo();
}

/** Drive the memo from a fake clock (tests); null restores `Date.now`. */
export function __setMemoClockForTests(clock: (() => number) | null): void {
  memoClock = clock ?? Date.now;
  invalidateOAuthTokenMemo();
}

/** The active OAuth token: the test override if set, else the memoized real
 * reader. */
export async function getOAuthToken(): Promise<OAuthToken | null> {
  if (tokenReaderOverride) return tokenReaderOverride();
  return readOAuthTokenMemoized();
}

/**
 * Fetch usage through the active fetcher seam. Pass the already-resolved `token`
 * (from {@link getOAuthToken}) so the fetch uses the same token the cache was
 * fingerprinted against (no second read, no TOCTOU). Omit it only in standalone
 * tests that rely on the token-reader override.
 */
export function getOAuthUsage(token?: OAuthToken): Promise<OAuthUsageResult> {
  const readToken: OAuthTokenReader = token
    ? () => token
    : (tokenReaderOverride ?? readOAuthToken);
  return fetchOAuthUsage(fetcherOverride ?? defaultFetcher, readToken);
}

// ── Diagnosis inputs (read-only, no credential stores) ───────────────────

/** Env var NAMES that route Claude Code away from a claude.ai login. */
const BEDROCK_FLAG = "CLAUDE_CODE_USE_BEDROCK";
const VERTEX_FLAG = "CLAUDE_CODE_USE_VERTEX";

function truthyFlag(value: unknown): boolean {
  if (typeof value !== "string") return value === true || value === 1;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

/**
 * Facts the N/A diagnosis needs, read from Claude Code's CONFIG files — never
 * from a credential store, and never returning a value that identifies the
 * user or their organization: plan LABELS (organizationType / billingType /
 * seatTier), whether an oauthAccount / primaryApiKey exists, and which auth
 * env flags are set (names only, from Claude Code's settings.json `env` block
 * and this server's own environment). Best-effort: unreadable files count as
 * "not present".
 */
export function readClaudeConfigHints(): {
  auth: AuthHints;
  plan: Omit<PlanHints, "subscriptionType">;
} {
  const cfg = process.env.CLAUDE_CONFIG_DIR?.trim();
  const home = homedir();
  const credentials = join(claudeConfigDir(), ".credentials.json");
  const auth: AuthHints = {
    hasOAuthAccount: false,
    apiKeyConfigured: false,
    cloudProvider: null,
    configDirOverride: Boolean(cfg),
    configReadable: true,
    credentialsPath: credentials.startsWith(`${home}/`)
      ? `~${credentials.slice(home.length)}`
      : credentials,
  };
  const plan: Omit<PlanHints, "subscriptionType"> = {};

  const candidates: string[] = [];
  if (cfg) candidates.push(join(cfg, ".claude.json"));
  candidates.push(join(homedir(), ".claude.json"));
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
        oauthAccount?: {
          organizationType?: unknown;
          billingType?: unknown;
          seatTier?: unknown;
        } | null;
        primaryApiKey?: unknown;
      };
      const account = parsed?.oauthAccount;
      if (account && typeof account === "object") {
        auth.hasOAuthAccount = true;
        if (typeof account.organizationType === "string")
          plan.organizationType = account.organizationType;
        if (typeof account.billingType === "string")
          plan.billingType = account.billingType;
        if (typeof account.seatTier === "string")
          plan.seatTier = account.seatTier;
      }
      if (typeof parsed?.primaryApiKey === "string" && parsed.primaryApiKey)
        auth.apiKeyConfigured = true;
      break; // first readable config wins, as in readAccountIdentity
    } catch (err) {
      // Absent → try the next candidate. PRESENT but unreadable/corrupt →
      // remember it, so "no oauthAccount" isn't read as "API-key login".
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT")
        auth.configReadable = false;
    }
  }

  // Claude Code's settings.json `env` block — flag NAMES only. This server's
  // OWN env is deliberately not consulted: a launchd service or a spawned
  // tool may carry ANTHROPIC_API_KEY / CLAUDE_CODE_USE_* that the user's own
  // `claude` never sees, which would mislabel an OAuth user.
  let settingsEnv: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(
      readFileSync(join(claudeConfigDir(), "settings.json"), "utf-8"),
    ) as { env?: Record<string, unknown> };
    if (parsed?.env && typeof parsed.env === "object") settingsEnv = parsed.env;
  } catch {
    /* no settings.json — fine */
  }
  const flag = (name: string) => truthyFlag(settingsEnv[name]);
  if (flag(BEDROCK_FLAG)) auth.cloudProvider = "bedrock";
  else if (flag(VERTEX_FLAG)) auth.cloudProvider = "vertex";
  if (
    typeof settingsEnv.ANTHROPIC_API_KEY === "string" &&
    settingsEnv.ANTHROPIC_API_KEY
  )
    auth.apiKeyConfigured = true;

  return { auth, plan };
}

// ── Spend (spend-metered accounts) ─────────────────────────────────────────

const warnedSpend = new Set<string>();
function warnSpendOnce(message: string): void {
  if (warnedSpend.has(message)) return;
  warnedSpend.add(message);
  console.warn(`[claude-usage] ${message}`);
}

/** Major units from a `spend`-style money object; null when unusable. The
 *  exponent must be an ISO-4217-style minor-unit count (integer 0–4) — a wild
 *  one would turn $5 into $50,000 or Infinity. */
function moneyMajor(
  raw: unknown,
): { amount: number; currency?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as RawMoney;
  const minor = limitPercent(m.amount_minor);
  if (minor === null || minor < 0) return null;
  const exp = m.exponent == null ? 2 : limitPercent(m.exponent);
  if (exp === null || !Number.isInteger(exp) || exp < 0 || exp > 4) {
    warnSpendOnce(
      `spend money object has an unusable exponent: ${JSON.stringify(m.exponent)}`,
    );
    return null;
  }
  return { amount: minor / 10 ** exp, currency: trimmedString(m.currency) };
}

/** One source's reading, before choosing between sources. */
interface SpendCandidate {
  used: number;
  currency?: string;
  /** set = a readable positive limit; none = the field is absent/null;
   *  unreadable = present but not usable (0, negative, unknown shape,
   *  other currency). Only "none" may be shown as "no limit set". */
  limitStatus: SpendLimit["limitStatus"];
  limit: number | null;
  resetsAt: string | null;
  source: SpendLimit["source"];
}

function finish(c: SpendCandidate): SpendLimit {
  const limit = c.limitStatus === "set" ? c.limit : null;
  return {
    used: c.used,
    limit,
    // Multiply first: (used / limit) * 100 turns 1120/1000 into 112.00000000000001.
    percent: limit === null ? null : (c.used * 100) / limit,
    currency: c.currency ?? "USD",
    resetsAt: c.resetsAt,
    source: c.source,
    limitStatus: c.limitStatus,
  };
}

function fromExtraUsage(
  extra: OAuthUsageRaw["extra_usage"],
  lenientEnabledFlag: boolean,
): SpendCandidate | null {
  if (!extra || typeof extra !== "object") return null;
  // The OAuth response always carries is_enabled (codexbar's OAuth fixtures,
  // Terry's Max payload); only the claude.ai web body omits it.
  const enabled = lenientEnabledFlag
    ? extra.is_enabled !== false
    : extra.is_enabled === true;
  if (!enabled) return null;
  const usedCents = limitPercent(extra.used_credits);
  if (usedCents === null || usedCents < 0) return null;
  let limitStatus: SpendLimit["limitStatus"] = "none";
  let limit: number | null = null;
  if (extra.monthly_limit != null) {
    const cents = limitPercent(extra.monthly_limit);
    if (cents !== null && cents > 0) {
      limitStatus = "set";
      limit = cents / 100;
    } else {
      limitStatus = "unreadable";
      warnSpendOnce(
        `extra_usage.monthly_limit is not a usable limit: ${JSON.stringify(extra.monthly_limit)}`,
      );
    }
  }
  return {
    used: usedCents / 100,
    currency: trimmedString(extra.currency),
    limitStatus,
    limit,
    resetsAt: null,
    source: "extra_usage",
  };
}

function fromSpendBlock(spend: OAuthUsageRaw["spend"]): SpendCandidate | null {
  if (!spend || typeof spend !== "object" || spend.enabled !== true)
    return null;
  const used = moneyMajor(spend.used);
  if (!used) return null;
  let limitStatus: SpendLimit["limitStatus"] = "none";
  let limit: number | null = null;
  if (spend.limit != null) {
    const l = moneyMajor(spend.limit);
    if (!l || l.amount <= 0) {
      limitStatus = "unreadable";
      warnSpendOnce(
        `spend.limit is not a readable money amount: ${JSON.stringify(spend.limit)}`,
      );
    } else if (used.currency && l.currency && used.currency !== l.currency) {
      limitStatus = "unreadable";
      warnSpendOnce(
        `spend.used (${used.currency}) and spend.limit (${l.currency}) are in different currencies`,
      );
    } else {
      limitStatus = "set";
      limit = l.amount;
    }
  }
  return {
    used: used.amount,
    currency: used.currency,
    limitStatus,
    limit,
    resetsAt: trimmedString(spend.resets_at) ?? null,
    source: "spend",
  };
}

/**
 * Spend against a spend limit, for an account with NO rolling window. Pure;
 * exported for tests. Two sources:
 *
 *  1. `extra_usage` — `used_credits` / `monthly_limit` in CENTS (codexbar's
 *     Enterprise fixtures and its #1114 minor-units fix).
 *  2. `spend` — `used` / `limit` as money objects, seen on Terry's Max payload
 *     with `enabled: false` and `limit: null`; the shape of a SET limit is
 *     inferred, so only a money object is accepted.
 *
 * The source with a readable limit wins; otherwise the first that shows spend.
 * Never invents a limit, and never reports an unreadable one as absent.
 * `web: true` is the claude.ai session-key body, which omits `is_enabled`.
 */
export function mapSpendLimit(
  raw: OAuthUsageRaw,
  opts: { web?: boolean } = {},
): SpendLimit | null {
  const candidates = [
    fromExtraUsage(raw.extra_usage, opts.web === true),
    fromSpendBlock(raw.spend),
  ].filter((c): c is SpendCandidate => c !== null);
  if (candidates.length === 0) return null;
  return finish(
    candidates.find((c) => c.limitStatus === "set") ?? candidates[0],
  );
}
