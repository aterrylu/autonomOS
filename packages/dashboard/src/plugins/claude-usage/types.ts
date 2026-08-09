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
  | "unavailable"
  | "stale_token";

/** True for failures a new session key can actually fix. `stale_token`
 * belongs here: an expired Claude Code login never clears on its own (the
 * token is read-only by contract, never refreshed), and pasting a key or
 * re-running `claude` IS the remedy — classifying it transient sent users
 * into a retry loop that could never succeed. */
export function isCredentialError(kind?: ErrorKind): boolean {
  return kind === "unauthorized" || kind === "no_org" || kind === "stale_token";
}

/** Where the active credential came from (mirrored from the server).
 * `oauth` is the zero-touch default — Claude Code's read-only login token. */
export type CredentialSource = "settings" | "env" | "oauth";

/** True when the credential was auto-detected from Claude Code (not pasted). */
export function isAutoDetected(source?: CredentialSource): boolean {
  return source === "oauth";
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
  /** Where the active session key came from. */
  credentialSource?: CredentialSource;
  /** True when no session key is configured anywhere */
  needsSetup?: boolean;
}

export type DisplayMode = "text" | "bar";
