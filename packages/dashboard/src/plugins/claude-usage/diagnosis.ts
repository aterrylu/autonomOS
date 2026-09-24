/**
 * Short status-bar labels for the server's usage diagnosis codes (mirrored
 * from `packages/server/src/plugins/claude-usage/credentialDiagnosis.ts`).
 * The bar has room for a couple of words; the full summary + hint ride in the
 * tooltip and the click panel. An unknown code (a newer server) falls back to
 * the caller's generic label, so a code added server-side can't blank the bar.
 */
import type { UsageDiagnosisCode } from "./types";

const SHORT_LABELS: Record<UsageDiagnosisCode, string> = {
  no_login: "setup needed",
  login_unreadable: "login unreadable",
  auto_detect_off: "setup needed",
  session_key_rejected: "key rejected",
  no_subscription_org: "no plan org",
  keychain_denied: "keychain denied",
  keychain_timeout: "keychain locked",
  credentials_unreadable: "login file blocked",
  credentials_malformed: "login file bad",
  api_key_auth: "API-key auth",
  cloud_provider_auth: "cloud auth",
  token_expired: "login expired",
  token_rejected: "login rejected",
  usage_forbidden: "blocked (403)",
  rate_limited: "rate-limited",
  network_unreachable: "offline",
  http_error: "API error",
  unexpected_response: "bad response",
  no_rolling_limits: "no windows",
};

export function diagnosisLabel(
  code: string | undefined,
  fallback: string,
): string {
  return code && Object.hasOwn(SHORT_LABELS, code)
    ? SHORT_LABELS[code as UsageDiagnosisCode]
    : fallback;
}

/** Tooltip text: summary, then the hint on its own line. */
export function diagnosisTitle(
  diagnosis: { summary: string; hint: string } | undefined,
  fallback: string,
): string {
  return diagnosis ? `${diagnosis.summary}\n${diagnosis.hint}` : fallback;
}
