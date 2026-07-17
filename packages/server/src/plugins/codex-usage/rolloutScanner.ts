/**
 * Codex usage via the on-disk rollout files (read-only FALLBACK).
 *
 * When the live endpoint is unreachable (expired token, offline, rate-limited),
 * we fall back to the last-known rate limits Codex already persisted. Every
 * turn, `codex app-server` appends a `token_count` event to that thread's
 * rollout JSONL at `{codexHome}/sessions/YYYY/MM/DD/rollout-*.jsonl`, and that
 * event carries the SAME account-global `rate_limits` the live endpoint returns
 * — just older.
 *
 * Rate limits are account-global (not per-thread), so the freshest snapshot is
 * the newest `token_count` event across the most-recently-written rollouts. We
 * scan the top-N files by mtime and pick the event with the newest timestamp.
 *
 * NOTE the rollout uses different field names than the live API
 * (`window_minutes` + `resets_at` vs `limit_window_seconds` + `reset_at`), so it
 * has its own window mapper here.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codexHome.js";
import type { CodexCredits, CodexUsageWindow } from "./types.js";
import { mapCredits } from "./usageApi.js";

/** How many recent rollout files to inspect for the freshest snapshot. Rate
 *  limits are account-global, so a handful of the most-recent threads is plenty
 *  to find the latest event without walking the entire history. */
const MAX_FILES_SCANNED = 8;

/** Raw rollout window shape (snake_case, epoch-seconds reset). */
interface RolloutWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

interface RolloutRateLimits {
  primary?: RolloutWindow | null;
  secondary?: RolloutWindow | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: number | null;
  } | null;
  plan_type?: string | null;
}

/** The mapped fallback snapshot. Shares the window/credit shapes with the live
 *  path; `snapshotAt` is the event's own timestamp (drives the age indicator). */
export interface RolloutSnapshot {
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits: CodexCredits | null;
  planType: string | null;
  snapshotAt: string;
}

/** Map a rollout window → the shared shape. Null when absent / no percent. */
export function mapRolloutWindow(
  raw: RolloutWindow | null | undefined,
): CodexUsageWindow | null {
  if (!raw || typeof raw.used_percent !== "number") return null;
  const resetsAt =
    typeof raw.resets_at === "number"
      ? new Date(raw.resets_at * 1000).toISOString()
      : null;
  return {
    usedPercent: raw.used_percent,
    windowMinutes:
      typeof raw.window_minutes === "number" ? raw.window_minutes : 0,
    resetsAt,
  };
}

/** Recursively collect `*.jsonl` files under a dir with their mtimes. Bounded
 *  by the filesystem; errors on individual entries are skipped, not fatal. */
function collectRolloutFiles(dir: string): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        out.push(...collectRolloutFiles(full));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push({ path: full, mtimeMs: statSync(full).mtimeMs });
      }
    } catch {
      /* transient stat/read race — skip this entry */
    }
  }
  return out;
}

/**
 * Find the last `token_count` event carrying `rate_limits` in one rollout file.
 * Scans lines from the END (the freshest event is last) and returns the first
 * match with its timestamp, or null. Malformed lines are skipped.
 */
function lastRateLimitsInFile(
  path: string,
): { rateLimits: RolloutRateLimits; timestamp: string } | null {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const lines = content.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes("rate_limits")) continue;
    try {
      const parsed = JSON.parse(line) as {
        timestamp?: string;
        payload?: { type?: string; rate_limits?: RolloutRateLimits | null };
      };
      const payload = parsed.payload;
      // Require a real timestamp — the freshest-event selection compares them,
      // and a timestamp-less event would otherwise render as a "1970" age.
      if (
        payload?.type === "token_count" &&
        payload.rate_limits &&
        typeof parsed.timestamp === "string"
      ) {
        return { rateLimits: payload.rate_limits, timestamp: parsed.timestamp };
      }
    } catch {
      /* not JSON / not the shape we want — keep scanning backwards */
    }
  }
  return null;
}

/**
 * Read the freshest account-global rate-limit snapshot from disk, or null when
 * no rollout with rate limits exists yet. Read-only; touches only rollout files.
 */
export function readFreshestRollout(
  env: NodeJS.ProcessEnv = process.env,
): RolloutSnapshot | null {
  const dir = join(codexHome(env), "sessions");
  const files = collectRolloutFiles(dir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_SCANNED);

  let best: { rateLimits: RolloutRateLimits; timestamp: string } | null = null;
  for (const { path } of files) {
    const found = lastRateLimitsInFile(path);
    // Compare parsed instants, not raw strings — robust to any timestamp format
    // drift (a lexical compare only works while every event is same-format UTC).
    if (
      found &&
      (!best || Date.parse(found.timestamp) > Date.parse(best.timestamp))
    ) {
      best = found;
    }
  }
  if (!best) return null;

  const rl = best.rateLimits;
  return {
    primary: mapRolloutWindow(rl.primary),
    secondary: mapRolloutWindow(rl.secondary),
    credits: mapCredits(rl.credits),
    planType: typeof rl.plan_type === "string" ? rl.plan_type : null,
    snapshotAt: best.timestamp,
  };
}
