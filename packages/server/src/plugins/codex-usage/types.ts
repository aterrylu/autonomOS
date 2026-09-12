/**
 * Shared types for the Codex usage plugin.
 *
 * The window model is deliberately provider-neutral and EXTENSIBLE: alongside
 * the two standard windows (primary/secondary) we carry an open-ended list of
 * named per-model limits (`additionalLimits`) so new Codex limit lanes — e.g.
 * "Codex Spark 5-hour", or whatever OpenAI adds next — surface automatically
 * without a schema change here or in the UI. Both the live `/wham/usage`
 * endpoint and the on-disk rollout map onto this same shape.
 */

/** One rate-limit window, normalized across the live API and the rollout file.
 *  `usedPercent` is 0–100; `windowMinutes` drives the human label (5h / 7d /
 *  30d); `resetsAt` is an ISO timestamp (or null when the source omits it). */
export interface CodexUsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string | null;
}

/** A named limit beyond the primary/secondary pair — a per-model or per-feature
 *  lane (e.g. Codex Spark). Kept open-ended for forward compatibility. */
export interface CodexNamedLimit {
  /** Stable id derived from the metered feature / limit name
   *  ("codex-base-model-inference"); mirrors codexbar's slug rule. */
  id?: string;
  /** Display label: the Codex CLI's wording for known lanes ("Luna Reserve"),
   *  a lightly prettified copy of the API's name for unknown ones — an unknown
   *  lane is never dropped (limitLabels.ts). */
  name: string;
  /** One-line explainer under the label; generic for unknown lanes. */
  description?: string;
  /** The metered feature this limit governs, when reported. */
  meteredFeature?: string;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
}

/** Prepaid credit balance (paid plans / credit grants). */
export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: number | null;
}

/** Where the numbers came from: the live endpoint or the on-disk rollout. */
export type CodexUsageSource = "live" | "rollout";

/** Failure category, mirrored to the dashboard so it shows the right remedy. */
export type CodexErrorKind =
  | "unauthorized"
  | "stale_token"
  | "rate_limited"
  | "unavailable";

/** Account identity for display (from the id_token JWT — read-only). */
export interface CodexAccountInfo {
  email?: string;
  planType?: string;
}

/** The full usage snapshot served at `/api/plugins/codex-usage`. */
export interface CodexUsageData {
  /** The short/session window (Codex `secondary_window`, e.g. 5h). */
  secondary: CodexUsageWindow | null;
  /** The long/weekly-or-monthly window (Codex `primary_window`). */
  primary: CodexUsageWindow | null;
  /** Per-model / per-feature limits beyond primary/secondary. Never null;
   *  empty when the source reports none. */
  additionalLimits: CodexNamedLimit[];
  credits: CodexCredits | null;
  planType: string | null;
  account: CodexAccountInfo;
  /** `live` = real-time from /wham/usage; `rollout` = last-known from disk. */
  source: CodexUsageSource;
  /** For `rollout`: the token_count event's own timestamp (drives the age
   *  indicator). Undefined for `live` (which is current by definition). */
  snapshotAt?: string;
  fetchedAt: string;
  error?: string;
  errorKind?: CodexErrorKind;
  /** True when there's no Codex signal at all (no auth.json, no rollout) — the
   *  dashboard hides the status-bar item entirely rather than nag. */
  needsData?: boolean;
}
