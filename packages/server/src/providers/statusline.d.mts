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

export function formatHierarchy(ctx: HierarchyContext): string;
export function formatActivity(
  cc: Record<string, unknown>,
  meta?: AutonomosMeta | null,
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
