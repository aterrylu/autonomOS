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
 * Failure category mirrored from the server (`scanner.ts`). Credential kinds
 * (`unauthorized`, `no_org`) warrant re-entering the key; transient kinds
 * (`rate_limited`, `unavailable`) do not — the key is fine, retry later.
 */
export type ErrorKind =
  | "unauthorized"
  | "no_org"
  | "rate_limited"
  | "unavailable";

/** True for failures a new session key can actually fix. */
export function isCredentialError(kind?: ErrorKind): boolean {
  return kind === "unauthorized" || kind === "no_org";
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
  /** Failure category, when `error` is set. */
  errorKind?: ErrorKind;
  /** True when CLAUDE_SESSION_KEY is not set */
  needsSetup?: boolean;
}

export type DisplayMode = "text" | "bar";
