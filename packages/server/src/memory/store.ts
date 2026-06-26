/**
 * Memory store paths and helpers — file-system layout for the hierarchical
 * memory system.
 *
 * Layout (under MEMORY_DIR = ~/.autonomos/memory/):
 *   SCHEMA.md                                  ← schema doc (auto-written on init)
 *   index.md                                   ← L0: catalog (auto-refreshed)
 *   projects/<slug>/summary.md                 ← L1: rolling project summary
 *   projects/<slug>/timeline.md                ← L2 per-project chronological
 *   daily/YYYY-MM-DD.md                        ← L2 cross-project (v3 fills)
 *   events/YYYY-MM/DD.jsonl                    ← L3: raw events
 *
 * v1 ships full L0 + L3; L1 and L2 are skeletons populated by v2/v3.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_SUMMARY_MAX } from "@autonomos/core";
import { getConfigDir } from "../configDir.js";

// ── Paths ──────────────────────────────────────────────────────────

export function getMemoryDir(): string {
  return join(getConfigDir(), "memory");
}

export function getSchemaDocPath(): string {
  return join(getMemoryDir(), "SCHEMA.md");
}

export function getIndexPath(): string {
  return join(getMemoryDir(), "index.md");
}

export function getProjectsDir(): string {
  return join(getMemoryDir(), "projects");
}

export function getProjectDir(slug: string): string {
  return join(getProjectsDir(), slug);
}

export function getProjectSummaryPath(slug: string): string {
  return join(getProjectDir(slug), "summary.md");
}

export function getProjectTimelinePath(slug: string): string {
  return join(getProjectDir(slug), "timeline.md");
}

export function getDailyDir(): string {
  return join(getMemoryDir(), "daily");
}

export function getDailyPath(dateIso: string): string {
  return join(getDailyDir(), `${dateIso}.md`);
}

export function getEventsDir(): string {
  return join(getMemoryDir(), "events");
}

/** Path of the JSONL file for a given event timestamp. Partitions by month. */
export function getEventsFile(ts: number): string {
  const d = new Date(ts);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return join(getEventsDir(), `${year}-${month}`, `${day}.jsonl`);
}

// ── Directory ensure ──────────────────────────────────────────────

export function ensureMemoryDirs(): void {
  for (const dir of [
    getMemoryDir(),
    getProjectsDir(),
    getDailyDir(),
    getEventsDir(),
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

// ── Slug normalization ────────────────────────────────────────────

const SLUG_MAX = 64;

/** Normalize a project name to a slug. Returns null if the input collapses
 *  to empty (treated as "untagged" — never force-tag). */
export function normalizeProjectSlug(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
  return slug.length === 0 ? null : slug;
}

// ── Event id generation ───────────────────────────────────────────

/** Sortable id: 12-hex ms timestamp + dash + 12-hex random.
 *  Lex order matches time order. 48 bits of entropy in the suffix is
 *  collision-safe at our event volume (~50K/year). */
export function makeEventId(ts: number): string {
  const tsHex = ts.toString(16).padStart(12, "0").toUpperCase();
  const rand = randomBytes(6).toString("hex").toUpperCase();
  return `${tsHex}-${rand}`;
}

// ── Summary truncation ────────────────────────────────────────────

/** Cap a summary at MEMORY_SUMMARY_MAX chars, appending "…" if truncated.
 *  Total output length is always ≤ MEMORY_SUMMARY_MAX. */
export function truncateSummary(s: string): string {
  if (s.length <= MEMORY_SUMMARY_MAX) return s;
  return `${s.slice(0, MEMORY_SUMMARY_MAX - 1)}…`;
}
