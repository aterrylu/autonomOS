/**
 * Hand-Off Queue store — reads/writes $configDir/handoff-queues/<agentId>.json
 *
 * One JSON file per agent, holding the messages queued for human hand-delivery
 * to an inbound-less agent (a "manual-queue" provider — Gemini today). Mirrors
 * the schedules.ts / envPresets.ts persistence pattern exactly:
 *   - dir resolved PER-CALL (not at module load) so the configDir test-escape
 *     guard (#350) and before-hook env isolation apply;
 *   - 0600 files under a 0700 dir (queued messages are user content);
 *   - a shape guard rejects a truncated / list-wrapped write BEFORE use;
 *   - writes are ATOMIC (temp file + rename) so an interrupted write can't
 *     corrupt a live queue.
 *
 * `readQueue` throws on a corrupt (non-ENOENT) file rather than silently
 * treating it as empty — losing a queue of user messages to a parse slip would
 * be exactly the silent loss this feature exists to prevent. Callers that feed
 * the always-on agent list (withPendingHandoffCount) MUST degrade a throw to
 * "no badge" so one bad file can't 500 the whole fleet view; the single-agent
 * queue endpoints surface the corruption honestly for that one agent.
 *
 * Persisted (Terry's Q2): the queue survives a restart/upgrade — an operator's
 * pending hand-offs are not lost when the server bounces.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { HandoffEnqueueResult, HandoffQueueItem } from "@autonomos/core";
import { HANDOFF_QUEUE_CAP } from "@autonomos/core";
import { getConfigDir } from "./configDir.js";

// Per-call (not module-load) so the configDir test-escape guard (#350) applies
// and env-based isolation set in a before-hook is honored (#272 class).
const QUEUE_DIR = () => join(getConfigDir(), "handoff-queues");

// Agent ids are UUIDs (lowercase hex + hyphens); this also blocks path-traversal
// via a crafted id reaching the filesystem join.
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function validateAgentId(agentId: string): void {
  if (!SAFE_ID_RE.test(agentId)) {
    throw new Error(
      `Invalid agent id "${agentId}" for hand-off queue: must be lowercase letters, digits, and hyphens`,
    );
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    // 0700: queued messages are user content — owner-only so another local
    // user can't read them. Mode applies on creation only.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

interface StoredQueue {
  agentId: string;
  items: HandoffQueueItem[];
}

/**
 * Reject a queue file that isn't a well-formed `{ agentId, items: [...] }`
 * BEFORE the caller acts on it. A bare `JSON.parse(...) as StoredQueue` would
 * accept `[]`, `null`, or a truncated object whose missing `items` then throws
 * on `.length`/`.push` deep in a delivery path. Validate the invariants only.
 */
function assertQueueShape(parsed: unknown, filePath: string): StoredQueue {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    let found: string;
    if (Array.isArray(parsed)) found = "an array";
    else if (parsed === null) found = "null";
    else found = `a ${typeof parsed}`;
    throw new Error(
      `expected a JSON object, found ${found} — check ${filePath} for a truncated or list-wrapped write`,
    );
  }
  const q = parsed as Record<string, unknown>;
  if (!Array.isArray(q.items)) {
    throw new Error(
      `hand-off queue ${filePath} is missing an "items" array — refusing to load a malformed queue`,
    );
  }
  for (const it of q.items) {
    if (
      it === null ||
      typeof it !== "object" ||
      typeof (it as HandoffQueueItem).id !== "string" ||
      typeof (it as HandoffQueueItem).from !== "string" ||
      typeof (it as HandoffQueueItem).message !== "string" ||
      typeof (it as HandoffQueueItem).enqueuedAt !== "number"
    ) {
      throw new Error(
        `hand-off queue ${filePath} has a malformed item — refusing to load`,
      );
    }
  }
  return parsed as StoredQueue;
}

function queuePath(agentId: string): string {
  return join(QUEUE_DIR(), `${agentId}.json`);
}

/** Read an agent's queue; a missing file is an empty queue (not an error). */
function readQueue(agentId: string): StoredQueue {
  validateAgentId(agentId);
  const filePath = queuePath(agentId);
  try {
    return assertQueueShape(
      JSON.parse(readFileSync(filePath, "utf-8")),
      filePath,
    );
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { agentId, items: [] };
    }
    throw new Error(
      `Failed to load hand-off queue for "${agentId}": ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Persist a queue. An EMPTY queue deletes its file rather than leaving a
 * `{items:[]}` husk — so the dir holds only agents with pending messages.
 *
 * ATOMIC: the JSON is written to a temp file and renamed over the target, so a
 * crash / ENOSPC mid-write leaves the previous good file intact (or nothing)
 * instead of a truncated file that the next read rejects as corrupt.
 */
function writeQueue(q: StoredQueue): void {
  validateAgentId(q.agentId);
  const filePath = queuePath(q.agentId);
  if (q.items.length === 0) {
    try {
      unlinkSync(filePath);
    } catch (err: unknown) {
      if (
        !(
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw err;
      }
    }
    return;
  }
  ensureDir(QUEUE_DIR());
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(q, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}

// ── Public API ──────────────────────────────────────────────────

/** All queued items for an agent, oldest first. Empty if none. */
export function listHandoffQueue(agentId: string): HandoffQueueItem[] {
  return readQueue(agentId).items;
}

/** Count of queued items — the source for the dashboard pending badge. */
export function handoffQueueCount(agentId: string): number {
  return readQueue(agentId).items.length;
}

/**
 * Enqueue a message for hand-delivery. Rejects (ok:false, reason:"full") once
 * the queue is at {@link HANDOFF_QUEUE_CAP} — a REAL failure the sender is told
 * about, distinct from the under-cap accept. Otherwise appends and returns the
 * new item + resulting count.
 */
export function enqueueHandoff(
  agentId: string,
  input: { from: string; message: string },
): HandoffEnqueueResult {
  const q = readQueue(agentId);
  if (q.items.length >= HANDOFF_QUEUE_CAP) {
    return { ok: false, reason: "full", count: q.items.length };
  }
  const item: HandoffQueueItem = {
    id: randomUUID(),
    from: input.from,
    message: input.message,
    enqueuedAt: Date.now(),
  };
  q.items.push(item);
  writeQueue(q);
  return { ok: true, item, count: q.items.length };
}

/**
 * Remove one item by id (a delivered send-one, or a discard-one). Returns the
 * removed item, or undefined if no item had that id (in which case nothing is
 * rewritten). The caller decides whether removal means "delivered" or
 * "discarded" — the store is trigger-agnostic.
 */
export function removeHandoffItem(
  agentId: string,
  itemId: string,
): HandoffQueueItem | undefined {
  const q = readQueue(agentId);
  const idx = q.items.findIndex((it) => it.id === itemId);
  if (idx === -1) return undefined;
  const [removed] = q.items.splice(idx, 1);
  writeQueue(q);
  return removed;
}

/** The oldest queued item, or undefined — used to pick the next to inject. */
export function peekNextHandoff(agentId: string): HandoffQueueItem | undefined {
  return readQueue(agentId).items[0];
}

/** Drop an agent's whole queue — called from deleteAgentRaw when the agent is
 *  deleted, so no orphan file of undelivered messages is left behind. */
export function clearHandoffQueue(agentId: string): void {
  writeQueue({ agentId, items: [] });
}
