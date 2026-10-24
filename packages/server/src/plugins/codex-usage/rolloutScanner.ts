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
 * Everything here is bounded and async: rollouts reach hundreds of MB, and a
 * whole-file sync read of the top files froze the server for seconds on every
 * fallback poll. Only recent day directories are listed, only each file's
 * tail is read (≤ MAX_TAIL_BYTES), and an unchanged file is not read again.
 *
 * NOTE the rollout uses different field names than the live API
 * (`window_minutes` + `resets_at` vs `limit_window_seconds` + `reset_at`), so it
 * has its own window mapper here.
 */

import { open } from "node:fs/promises";
import { join } from "node:path";
import { newestFiles, recentCodexRolloutPaths } from "../../sessionScanners.js";
import { codexHome } from "./codexHome.js";
import type { CodexCredits, CodexUsageWindow } from "./types.js";
import { mapCredits, parseNumber } from "./usageApi.js";

/** How many recent rollout files to inspect for the freshest snapshot. Rate
 *  limits are account-global, so a handful of the most-recent threads is plenty
 *  to find the latest event without walking the entire history. */
const MAX_FILES_SCANNED = 8;

/** Backward tail read: chunk size, and the most bytes read from one file.
 *  Codex appends a token_count every turn, so the freshest one sits within the
 *  last turn's worth of output; a file whose last 8MB holds none is treated as
 *  having no event rather than read further (single rollouts reach 500MB). */
export const TAIL_CHUNK_BYTES = 256 * 1024;
export const MAX_TAIL_BYTES = 8 * 1024 * 1024;

/** Lines without this byte sequence are skipped before they are decoded. */
const RATE_LIMITS = Buffer.from("rate_limits");

/** Raw rollout window shape (snake_case, epoch-seconds reset). Numeric fields
 *  may arrive as numeric STRINGS, same as the live endpoint (see usageApi.ts
 *  `parseNumber`) — the fallback is the path with no second chance, so it
 *  tolerates the same quoting the live path does. */
interface RolloutWindow {
  used_percent?: number | string | null;
  window_minutes?: number | string | null;
  resets_at?: number | string | null;
}

interface RolloutRateLimits {
  primary?: RolloutWindow | null;
  secondary?: RolloutWindow | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: number | string | null; // same serializer as the live endpoint
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
  if (!raw || typeof raw !== "object") return null;
  const usedPercent = parseNumber(raw.used_percent);
  if (usedPercent === null) return null;
  const minutes = parseNumber(raw.window_minutes);
  const resetAt = parseNumber(raw.resets_at);
  return {
    usedPercent,
    windowMinutes: minutes ?? 0,
    resetsAt: resetAt === null ? null : new Date(resetAt * 1000).toISOString(),
  };
}

type Found = { rateLimits: RolloutRateLimits; timestamp: string };

/** The newest `token_count` carrying `rate_limits` in one complete JSONL line,
 *  or null. The byte check runs before any decoding. */
function parseRateLimitsLine(line: Buffer): Found | null {
  if (line.indexOf(RATE_LIMITS) === -1) return null;
  try {
    const parsed = JSON.parse(line.toString("utf8")) as {
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
    /* not JSON (or a line still being written) — keep scanning backwards */
  }
  return null;
}

/**
 * Find the last `token_count` event carrying `rate_limits` in one rollout file,
 * reading BACKWARD from EOF in {@link TAIL_CHUNK_BYTES} chunks and giving up
 * after {@link MAX_TAIL_BYTES}. Lines are split on the raw `\n` byte, so a
 * chunk boundary inside a multi-byte character can't corrupt a line, and a
 * line longer than a chunk is assembled from its pieces only once complete.
 */
export async function lastRateLimitsInFile(
  path: string,
  size: number,
): Promise<Found | null> {
  const fh = await open(path, "r");
  try {
    let pos = size;
    // The pieces (in file order) of the line whose START we haven't reached.
    let partial: Buffer[] = [];
    while (pos > 0 && size - pos < MAX_TAIL_BYTES) {
      const len = Math.min(
        TAIL_CHUNK_BYTES,
        pos,
        MAX_TAIL_BYTES - (size - pos),
      );
      pos -= len;
      const chunk = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(chunk, 0, len, pos);
      if (bytesRead < len) return null; // truncated under us — next poll retries
      const last = chunk.lastIndexOf(0x0a);
      if (last === -1) {
        partial.unshift(chunk);
        continue;
      }
      // The line after this chunk's last newline completes the partial one.
      const found = parseRateLimitsLine(
        Buffer.concat([chunk.subarray(last + 1), ...partial]),
      );
      if (found) return found;
      let end = last;
      // NB: lastIndexOf with a negative offset counts from the END — guard it.
      while (end > 0) {
        const nl = chunk.lastIndexOf(0x0a, end - 1);
        if (nl === -1) break;
        const hit = parseRateLimitsLine(chunk.subarray(nl + 1, end));
        if (hit) return hit;
        end = nl;
      }
      partial = [chunk.subarray(0, end)];
    }
    // Reached the start of the file: what's left is its first line.
    return pos === 0 ? parseRateLimitsLine(Buffer.concat(partial)) : null;
  } finally {
    await fh.close();
  }
}

/** Per-file result, valid while size and mtime are unchanged — an idle
 *  rollout is read once, not once per poll. Pruned to the current top files. */
const fileCache = new Map<
  string,
  { size: number; mtimeMs: number; found: Found | null }
>();

/** Forget every cached per-file result (tests; usage-cache invalidation). */
export function clearRolloutCache(): void {
  fileCache.clear();
}

/**
 * Read the freshest account-global rate-limit snapshot from disk, or null when
 * no rollout with rate limits exists yet. Read-only; touches only rollout files.
 */
export async function readFreshestRollout(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RolloutSnapshot | null> {
  let candidates: string[];
  try {
    // 2× headroom: a thread's day bucket is its CREATION date, so a long-lived
    // thread can be newer by mtime than files in a newer day.
    candidates = await recentCodexRolloutPaths(
      join(codexHome(env), "sessions"),
      MAX_FILES_SCANNED * 2,
    );
  } catch {
    return null; // sessions dir unreadable: no fallback, same as "none yet"
  }
  // Re-check files that were in the top set last time, wherever they live.
  for (const path of fileCache.keys())
    if (!candidates.includes(path)) candidates.push(path);
  const files = await newestFiles(candidates, MAX_FILES_SCANNED);

  let best: Found | null = null;
  const keep = new Set<string>();
  for (const { path, size, mtimeMs } of files) {
    keep.add(path);
    const hit = fileCache.get(path);
    let found: Found | null;
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
      found = hit.found;
    } else {
      try {
        found = await lastRateLimitsInFile(path, size);
      } catch {
        continue; // vanished / unreadable: not cached, retried next poll
      }
      fileCache.set(path, { size, mtimeMs, found });
    }
    // Compare parsed instants, not raw strings — robust to any timestamp format
    // drift (a lexical compare only works while every event is same-format UTC).
    if (
      found &&
      (!best || Date.parse(found.timestamp) > Date.parse(best.timestamp))
    ) {
      best = found;
    }
  }
  for (const path of fileCache.keys())
    if (!keep.has(path)) fileCache.delete(path);
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
