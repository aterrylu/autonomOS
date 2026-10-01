/**
 * Type declarations for statusline.mjs (a runtime-only ES module spawned
 * by Claude Code as a child process). The .mjs is intentionally plain JS
 * so it ships without a build step; this .d.ts surfaces its exports for
 * TypeScript test code that imports the module directly.
 *
 * Not part of any public contract — safe to update alongside the .mjs.
 */

export interface HierarchyContext {
  name: string;
  manager: string | null;
  directReports: number | null | undefined;
}

export interface AutonomosMeta {
  name: string;
  manager: string | null;
  project: string | null;
  directReports: number;
}

export function formatHierarchy(
  ctx: HierarchyContext,
  opts?: { stale?: boolean },
): string;
export function formatActivity(
  cc: Record<string, unknown>,
  meta?: AutonomosMeta | null,
  branch?: string | null,
): string;
export function buildBar(
  pct: number | null | undefined,
  width?: number,
): string;
export function formatDuration(ms: number | null | undefined): string;
export function getAutonomosMeta(
  sessionId: string,
  serverUrl: string,
  token?: string,
): Promise<AutonomosMeta | null>;
export function getSelfMeta(
  sessionId: string,
  serverUrl: string,
  agentToken?: string,
): Promise<AutonomosMeta | null>;

export type SelfResult =
  | { meta: AutonomosMeta; error?: undefined; status?: undefined }
  | {
      meta?: undefined;
      error: "no-token" | "http" | "bad-body" | "refused" | "timeout" | "other";
      status?: number;
    };

export interface StatuslineCache {
  meta?: AutonomosMeta;
  metaAt?: number;
  branch?: string;
}

export type Identity =
  | { kind: "fresh"; meta: AutonomosMeta }
  | { kind: "cached"; meta: AutonomosMeta; stale: boolean }
  | { kind: "offline" };

export function fetchSelf(
  sessionId: string,
  serverUrl: string,
  agentToken?: string,
): Promise<SelfResult>;
export function chooseIdentity(
  result: { meta?: AutonomosMeta; error?: string; status?: number },
  cache: StatuslineCache | null,
  now: number,
): Identity;
export function readGitBranch(cwd: string, ceiling?: string): string | null;
export function resolveBranch(
  cc: Record<string, unknown>,
  cachedBranch?: string | null,
): string | null;
export const STALE_AFTER_MS: number;
export const OFFLINE_AFTER_MS: number;
