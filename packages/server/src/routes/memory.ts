/**
 * REST API for the hierarchical memory store.
 *
 * `GET /api/memory` is a thin adapter over `queryMemory` — validation and
 * level-routing all happen there. The route translates query-string params
 * into a MemoryQuery and maps validation errors (thrown by queryMemory) to
 * 400 responses.
 *
 * Used by:
 *   - the channel MCP subprocess (forwards `memory_query` here via serverFetch)
 *   - any other external client that wants the same data without going
 *     through the MCP transport
 */

import type {
  MemoryEventType,
  MemoryLevel,
  MemoryQuery,
} from "@autonomos/core";
import { Hono } from "hono";
import { queryMemory } from "../memory/events.js";

export const memoryRouter = new Hono();

const VALID_LEVELS: ReadonlySet<MemoryLevel> = new Set<MemoryLevel>([
  "L0",
  "L1",
  "L2",
  "L3",
]);

memoryRouter.get("/", (c) => {
  const q = c.req.query();
  const query: MemoryQuery = {};

  if (q.level !== undefined) {
    if (!VALID_LEVELS.has(q.level as MemoryLevel)) {
      return c.json(
        { error: `Invalid level "${q.level}" — expected L0|L1|L2|L3` },
        400,
      );
    }
    query.level = q.level as MemoryLevel;
  }

  if (q.project !== undefined) query.project = q.project;
  if (q.date !== undefined) query.date = q.date;
  if (q.id !== undefined) query.id = q.id;
  if (q.actor !== undefined) query.actor = q.actor;

  if (q.since !== undefined) {
    const n = Number(q.since);
    if (!Number.isFinite(n)) {
      return c.json(
        { error: `Invalid since "${q.since}" — expected number` },
        400,
      );
    }
    query.since = n;
  }
  if (q.until !== undefined) {
    const n = Number(q.until);
    if (!Number.isFinite(n)) {
      return c.json(
        { error: `Invalid until "${q.until}" — expected number` },
        400,
      );
    }
    query.until = n;
  }
  if (q.limit !== undefined) {
    const n = Number(q.limit);
    if (!Number.isFinite(n)) {
      return c.json(
        { error: `Invalid limit "${q.limit}" — expected number` },
        400,
      );
    }
    query.limit = n;
  }
  if (q.type !== undefined) {
    // Accept comma-separated list: ?type=agent_message,schedule_fired
    query.type = q.type
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as MemoryEventType[];
  }

  try {
    return c.json(queryMemory(query));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return c.json({ error: message }, 400);
  }
});
