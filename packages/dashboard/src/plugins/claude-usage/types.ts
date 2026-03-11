export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
}

export interface RateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  utilization?: number;
  resetsAt?: number;
  type?: string;
}

export interface UsageSummary {
  models: Record<string, ModelUsage>;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  rateLimit?: RateLimitInfo;
  window: { start: number; end: number };
}
