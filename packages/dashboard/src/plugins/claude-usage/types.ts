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

export interface RateLimitData {
  fiveHour: RateLimitWindow | null;
  sevenDay: RateLimitWindow | null;
  sevenDaySonnet: RateLimitWindow | null;
  sevenDayOpus: RateLimitWindow | null;
  extraUsage: ExtraUsage | null;
  account: AccountInfo;
  fetchedAt: string;
  error?: string;
  /** True when CLAUDE_SESSION_COOKIE is not set */
  needsSetup?: boolean;
}

export type DisplayMode = "text" | "bar";
