/**
 * Client mirror of the server's Codex usage types
 * (packages/server/src/plugins/codex-usage/types.ts). Kept as a hand-copy — the
 * same pattern claude-usage uses — so the dashboard has no server import.
 */

export interface CodexUsageWindow {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: string | null;
}

export interface CodexNamedLimit {
  id?: string;
  name: string;
  meteredFeature?: string;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
}

export interface CodexCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: number | null;
}

export type CodexUsageSource = "live" | "rollout";

export type CodexErrorKind =
  | "unauthorized"
  | "stale_token"
  | "rate_limited"
  | "unavailable";

export interface CodexAccountInfo {
  email?: string;
  planType?: string;
}

export interface CodexUsageData {
  secondary: CodexUsageWindow | null;
  primary: CodexUsageWindow | null;
  additionalLimits: CodexNamedLimit[];
  credits: CodexCredits | null;
  planType: string | null;
  account: CodexAccountInfo;
  source: CodexUsageSource;
  snapshotAt?: string;
  fetchedAt: string;
  error?: string;
  errorKind?: CodexErrorKind;
  needsData?: boolean;
}

/** True for failures the user can fix by re-authenticating the Codex CLI. */
export function isCodexCredentialError(kind?: CodexErrorKind): boolean {
  return kind === "unauthorized" || kind === "stale_token";
}
