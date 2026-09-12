/**
 * Read a Codex agent's last reply off its rollout file — the source for the
 * "AgentMessage" notification that lets a completed Codex turn show in the bell
 * panel + count toward the unread badge (F3 Part 2).
 *
 * WHY the file and not the app-server: the gateway's Codex status client is a
 * NON-CREATOR subscriber (it sees thread/status/changed + thread/read for STATUS
 * only, never turn/item events — #352). The reply text is not on that channel.
 * But Codex writes every turn to its rollout JSONL (the source of truth), so we
 * read it there — no extra RPC, no turn/item subscription, and no ADR-060 concern
 * (this is a file read for a NOTIFICATION, not any thread RPC or delivery gate).
 *
 * Rollout layout (mirrors rolloutScanner): {codexHome}/sessions/YYYY/MM/DD/
 * rollout-<ISO>-<threadId>.jsonl. The agent's reply is an `event_msg` line whose
 * payload is `{ type: "agent_message", message: "<text>" }`.
 *
 * Best-effort by contract: ANY failure (no rollout yet, not-yet-flushed, a
 * garbled tail line, an I/O error) returns null. The caller runs inside the
 * Codex WS event loop, so this must never throw.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "../plugins/codex-usage/codexHome.js";

/** Only the tail matters — the final reply is at the end of the rollout. Reading
 *  a bounded window keeps this cheap even for a multi-MB long-running session. */
const TAIL_BYTES = 256 * 1024;
/** Cap the notification body so one verbose turn can't bloat the panel/state. */
const MAX_MESSAGE_CHARS = 1000;

// A thread's rollout PATH never changes, but this runs inside the Codex WS event
// loop (which also carries terminal streaming, ADR-072) on EVERY turn boundary —
// so a full recursive sync walk of ~/.codex/sessions per turn is a real
// event-loop stall for a heavy Codex user (thousands of files). Cache the
// resolved path per thread → we walk once per thread, not once per turn (nox).
const rolloutPathCache = new Map<string, string>();

/** Test hook — clear the resolved-path cache between cases. */
export function _resetCodexRolloutCacheForTesting(): void {
  rolloutPathCache.clear();
}

/** Find the newest rollout file whose name carries this thread/session id.
 *  Bounded to the sessions/YYYY/MM/DD depth; per-entry errors are skipped.
 *  Cached per thread (the path is stable) so the walk runs once, not per turn. */
function findRolloutPath(threadId: string): string | null {
  const cached = rolloutPathCache.get(threadId);
  if (cached) {
    try {
      statSync(cached); // still there? (a delete would make it stale)
      return cached;
    } catch {
      rolloutPathCache.delete(threadId);
    }
  }
  // codexHome() → os.homedir() can throw on a pathological env (no HOME/passwd);
  // keep it inside the boundary so this function honors its own never-throws
  // contract at the seam, not only because the caller happens to catch.
  let root: string;
  try {
    root = join(codexHome(), "sessions");
  } catch {
    return null;
  }
  // Primitive accumulators (not a closed-over object): TS flow-narrowing doesn't
  // track a closure's reassignment of an object-typed `let`, which trips up a
  // later property read; two primitives sidestep that cleanly.
  let bestPath: string | null = null;
  let bestMtimeMs = -1;
  const walk = (dir: string, depth: number): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 3) walk(full, depth + 1);
      } else if (
        e.isFile() &&
        e.name.endsWith(".jsonl") &&
        e.name.includes(threadId)
      ) {
        try {
          const mtimeMs = statSync(full).mtimeMs;
          if (mtimeMs > bestMtimeMs) {
            bestMtimeMs = mtimeMs;
            bestPath = full;
          }
        } catch {
          /* stat raced a delete — skip */
        }
      }
    }
  };
  walk(root, 0);
  if (bestPath) rolloutPathCache.set(threadId, bestPath);
  return bestPath;
}

/** Read the last `TAIL_BYTES` of a file as UTF-8, or null on any error. The
 *  leading (possibly mid-line) fragment is fine — the line scan tolerates it. */
function readTail(path: string): string | null {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const len = size - start;
    if (len <= 0) return "";
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, start);
    return buf.subarray(0, read).toString("utf-8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/** A Codex agent's last reply plus the rollout line's own timestamp — the caller
 *  dedups on `ts` (not text) so a genuinely-repeated reply ("Done." each cron
 *  run) still counts while a stale RE-READ of the same line is skipped. */
export interface CodexAgentReply {
  message: string;
  /** The rollout line's top-level timestamp — unique per emitted event, so it
   *  identifies THIS reply occurrence, not merely its text. */
  ts: string;
}

/**
 * The agent's last reply (message + occurrence timestamp) from the thread's
 * rollout, truncated, or null. Never throws.
 */
export function readLastCodexAgentMessage(
  threadId: string,
): CodexAgentReply | null {
  const path = findRolloutPath(threadId);
  if (!path) return null;
  const tail = readTail(path);
  if (!tail) return null;
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a partial/garbled tail line — keep scanning upward
    }
    const obj = parsed as {
      type?: string;
      timestamp?: unknown;
      payload?: { type?: string; message?: unknown };
    };
    const p = obj?.payload;
    if (
      obj?.type === "event_msg" &&
      p?.type === "agent_message" &&
      typeof p.message === "string" &&
      p.message.length > 0
    ) {
      const message =
        p.message.length > MAX_MESSAGE_CHARS
          ? `${p.message.slice(0, MAX_MESSAGE_CHARS)}…`
          : p.message;
      // ts identifies this occurrence; fall back to the line index if a rollout
      // ever lacks a timestamp (they don't in practice) so dedup never collapses
      // two distinct reads to an undefined key.
      const ts =
        typeof obj.timestamp === "string" ? obj.timestamp : `line:${i}:${path}`;
      return { message, ts };
    }
  }
  return null;
}
