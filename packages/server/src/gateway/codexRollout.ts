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
 * rollout-<ISO>-<threadId>.jsonl. The agent's reply is (codex 0.15x) a
 * `response_item` line whose payload is `{ type: "message", role: "assistant",
 * content: [{ type: "output_text", text }] }`; older codex (≤0.144) wrote an
 * `event_msg` line with `{ type: "agent_message", message }`. Both are handled
 * by `extractAssistantReply`, the single source of truth for the reply shape.
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

/** Text of one content item. Codex 0.15x carries the reply as
 *  `content: [{ type: "output_text", text }]`; we take any item exposing a
 *  string `text` so a future content-item kind still yields its text. */
function contentItemText(item: unknown): string {
  if (
    item &&
    typeof item === "object" &&
    typeof (item as { text?: unknown }).text === "string"
  ) {
    return (item as { text: string }).text;
  }
  return "";
}

/**
 * Extract an assistant reply (message + occurrence ts) from ONE parsed rollout
 * line, or null if the line isn't an assistant reply.
 *
 * THE single source of truth for the codex reply shape — any other rollout
 * reader (e.g. the future codex-discovery scanner, currently parked) MUST reuse
 * this rather than re-encode the shape. Re-encoding is exactly what broke the
 * unread badge: F3 was written against `event_msg/agent_message`, a shape codex
 * had already dropped by the time it shipped, so every read returned null and no
 * turn ever counted. Two shapes handled, newest first:
 *   - 0.15x+ : { type:"response_item", payload:{ type:"message",
 *               role:"assistant", content:[{ type:"output_text", text }] } }
 *   - ≤0.144 : { type:"event_msg", payload:{ type:"agent_message", message } }
 *
 * `ts` is the line's top-level `timestamp` (occurrence identity for dedup), or a
 * synthetic `line:<i>:<path>` when absent so dedup never collapses two reads.
 */
export function extractAssistantReply(
  obj: unknown,
  lineIndex: number,
  path: string,
): CodexAgentReply | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as {
    type?: string;
    timestamp?: unknown;
    payload?: {
      type?: string;
      role?: string;
      message?: unknown;
      content?: unknown;
    };
  };
  const p = o.payload;
  if (!p) return null;

  let text: string | null = null;
  // NEW (0.15x): response_item / message / assistant, text in content[].
  if (
    o.type === "response_item" &&
    p.type === "message" &&
    p.role === "assistant"
  ) {
    if (Array.isArray(p.content)) {
      const joined = p.content.map(contentItemText).join("");
      if (joined.length > 0) text = joined;
    } else if (typeof p.content === "string" && p.content.length > 0) {
      text = p.content;
    }
  }
  // OLD (≤0.144): event_msg / agent_message / message string. Back-compat for
  // older codex versions and rollouts already on disk.
  else if (
    o.type === "event_msg" &&
    p.type === "agent_message" &&
    typeof p.message === "string" &&
    p.message.length > 0
  ) {
    text = p.message;
  }

  if (text === null) return null;
  const message =
    text.length > MAX_MESSAGE_CHARS
      ? `${text.slice(0, MAX_MESSAGE_CHARS)}…`
      : text;
  const ts =
    typeof o.timestamp === "string" ? o.timestamp : `line:${lineIndex}:${path}`;
  return { message, ts };
}

/**
 * The agent's last reply (message + occurrence timestamp) from the thread's
 * rollout, truncated, or null. Scans the tail newest-first and returns the last
 * assistant reply (the final answer). Never throws.
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
    const reply = extractAssistantReply(parsed, i, path);
    if (reply) return reply;
  }
  return null;
}
