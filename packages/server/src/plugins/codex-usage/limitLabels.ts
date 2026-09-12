/**
 * Display names for Codex `additional_rate_limits` entries.
 *
 * The usage endpoint names each extra lane with an internal id — on the Pro 5x
 * plan that is `GPT-5.3-Codex-Spark` and `gpt-reserve`. The Codex CLI's own
 * `/status` relabels `gpt-reserve` to "Luna Reserve" (codex-rs/tui/src/
 * model_catalog.rs) and shows Spark under its model name; we match the CLI so
 * the dashboard says the same words the user sees inside `codex`.
 *
 * FUTURE-SAFETY CONTRACT (Terry, 2026-09-12): the friendly table covers KNOWN
 * names only. Any name the API sends tomorrow must still render — lightly
 * prettified, with a generic explainer — and must never be dropped. The
 * fixture test with an invented `limit_name` pins this. New names showing up
 * here are the weekly upstream check's cue to add a friendly label; until then
 * the bar is correct-if-unlabeled.
 */

/** The raw identity fields one `additional_rate_limits[]` entry carries. */
export interface RawLimitIdentity {
  limitName?: string | null;
  meteredFeature?: string | null;
  /** The ordinary model a reserve lane stands in for (e.g. "gpt-5.6-luna"). */
  normalModelSlug?: string | null;
}

/** Codex's id for the Luna Reserve lane (LUNA_RESERVE_MODEL in the CLI). */
const RESERVE_LIMIT_NAME = "gpt-reserve";

/** Tokens spelled in caps when a slug is prettified ("gpt-5" → "GPT-5"). */
const UPPERCASE_TOKENS = new Set(["gpt", "api", "cbp", "k12"]);

/** Trimmed string or undefined. Typed loosely on purpose: a non-string value
 *  (the endpoint is lossy by contract) must degrade to "absent", not throw out
 *  of the mapper and take the whole response down. */
function trimmed(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

/** True for an all-lowercase machine slug ("codex_bengalfox", "gpt-reserve").
 *  Anything with an uppercase letter or a space was cased by its author
 *  ("GPT-5.3-Codex-Spark", "Codex Spark 5-hour") and is shown verbatim. */
function isMachineSlug(value: string): boolean {
  return /^[a-z0-9._-]+$/.test(value);
}

function capitalizeToken(token: string): string {
  if (UPPERCASE_TOKENS.has(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Light prettifier for an UNKNOWN machine slug: split on `-`/`_`, capitalize
 * each word, keep a leading version number attached to its prefix.
 *   "codex_bengalfox" → "Codex Bengalfox"; "gpt-5.6-luna" → "GPT-5.6 Luna".
 * Author-cased names pass through untouched.
 */
export function prettifyLimitName(raw: string): string {
  const value = raw.trim();
  if (!isMachineSlug(value)) return value;
  const tokens = value.split(/[-_]+/).filter(Boolean);
  if (tokens.length === 0) return value;
  // Seedless reduce: the first word never takes a separator.
  return tokens
    .map(capitalizeToken)
    .reduce((out, word) => `${out}${/^\d/.test(word) ? "-" : " "}${word}`);
}

/** codexbar's slug rule (CodexAdditionalRateLimitMapper.slug): lowercase,
 *  runs of non-alphanumerics → one dash, trimmed. */
function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isReserve(identity: RawLimitIdentity): boolean {
  return trimmed(identity.limitName)?.toLowerCase() === RESERVE_LIMIT_NAME;
}

/** Token match, not substring: "GPT-5.3-Codex-Spark" / "codex_spark" are
 *  Spark, a hypothetical "sparkle_engine" is not. */
function isSpark(identity: RawLimitIdentity): boolean {
  return [identity.limitName, identity.meteredFeature].some((v) => {
    const t = trimmed(v);
    return t ? slug(t).split("-").includes("spark") : false;
  });
}

/**
 * Stable id for React keys / the usage queue — `codex-<slug>` from the metered
 * feature, else the limit name (mirrors codexbar so ids line up across tools).
 * Undefined only when the entry carries no identity at all.
 */
export function limitId(identity: RawLimitIdentity): string | undefined {
  const source =
    trimmed(identity.meteredFeature) ?? trimmed(identity.limitName);
  if (!source) return undefined;
  const s = slug(source);
  return s ? `codex-${s}` : undefined;
}

/**
 * Human label. Known lanes get the Codex CLI's wording; unknown lanes are
 * prettified from whatever the API sent, never dropped.
 */
export function limitDisplayName(identity: RawLimitIdentity): string {
  if (isReserve(identity)) return "Luna Reserve";
  const source =
    trimmed(identity.limitName) ?? trimmed(identity.meteredFeature);
  return source ? prettifyLimitName(source) : "Limit";
}

/**
 * One-line explainer under the label. Known lanes get a specific sentence;
 * everything else gets the generic one so a brand-new lane still reads as
 * intentional rather than as a leaked identifier.
 */
export function limitDescription(identity: RawLimitIdentity): string {
  if (isReserve(identity)) {
    const model = trimmed(identity.normalModelSlug);
    const modelLabel = model ? prettifyLimitName(model) : "the reserve model";
    return `Fallback lane · ${modelLabel}, used once ordinary usage runs out`;
  }
  if (isSpark(identity)) return "Separate model with its own usage meters";
  return "Additional usage lane";
}
