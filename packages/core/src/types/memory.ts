/**
 * Hierarchical memory types — cross-agent activity log for autonomOS.
 *
 * v1 scope: only autonomOS-unique events (cross-agent activity that no other
 * substrate captures). Per-project state docs (project.md, handoffs/) remain
 * in CC auto-memory or claude_book — autonomOS does not duplicate.
 *
 * Read path is hierarchical, top-down with drill-down:
 *   L0 — index.md                (catalog of projects, always cheap to read)
 *   L1 — projects/<slug>/summary.md   (rolling per-project summary)
 *   L2 — projects/<slug>/timeline.md  (per-project chronological)
 *      OR daily/YYYY-MM-DD.md          (cross-project daily rollup)
 *   L3 — events/YYYY-MM/DD.jsonl  (raw events; payload as field, not separate layer)
 *
 * v1 ships full L0 + L3 and skeleton L1/L2; content generation for L1/L2
 * defers to v2 (Stop-hook → claude -p) and v3 (daily cron). See SCHEMA.md
 * (auto-written on first init) for the canonical reference.
 */

/** Schema version. Bump when MemoryEvent shape changes incompatibly. */
export const MEMORY_SCHEMA_VERSION = 1;

/** Max length of MemoryEvent.summary. Long bodies belong in payload, not summary. */
export const MEMORY_SUMMARY_MAX = 280;

/** Hierarchy retrieval level. L3 has multiple internal access patterns
 *  (single-event by id, scan with filters); they share the same level. */
export type MemoryLevel = "L0" | "L1" | "L2" | "L3";

/**
 * Event types — autonomOS-unique activity only. Clients should treat unknown
 * values as opaque for forward compatibility (future versions may add types).
 *
 * Captured implicitly by:
 *   - Hook relay (filtered to notable types):
 *       prompt_received, brief, notification
 *   - Gateway router:
 *       agent_message
 *   - HTTP API mutations:
 *       agent_created, agent_exited, agent_resumed, manager_set,
 *       schedule_created, schedule_fired, schedule_completed
 *
 * Dispatcher-curated entries (decisions, findings, todos, milestones, notes)
 * are intentionally NOT in this set — they belong in CC auto-memory at
 * ~/.claude/projects/<encoded-cwd>/memory/, written via the standard Write
 * tool. See SCHEMA.md for the rationale.
 */
export type MemoryEventType =
  | "agent_created"
  | "agent_exited"
  | "agent_resumed"
  | "agent_message"
  | "prompt_received"
  | "brief"
  | "notification"
  | "schedule_created"
  | "schedule_fired"
  | "schedule_completed"
  | "manager_set";

/** Who or what produced the event. */
export interface MemoryActor {
  /** Agent.id from the agents store. Null for system-emitted events
   *  (e.g. scheduler firing without an originating agent). */
  agentId: string | null;
  /** Display name at log time — frozen for historical fidelity even if
   *  the agent is renamed later. */
  agentName: string;
  /** Provider session id (CC sessionId for claude-code). Null if unknown. */
  sessionId: string | null;
}

/** Cross-references for joining events into chains, queries, and rollups.
 *  All fields optional. */
export interface MemoryRefs {
  /** Other agents this event touches (recipients, spawned children, etc). */
  agentIds?: string[];
  /** GitHub PR refs in `owner/repo#NUM` form. */
  prs?: string[];
  /** Filesystem paths or URIs. Accepts both local paths and remote URIs
   *  (gs://, s3://, etc) — see SCHEMA.md "Forensic preservation" for the
   *  pattern of pointing at quarantined evidence. */
  files?: string[];
  /** Schedule names this event references. */
  schedules?: string[];
  /** Parent event id — links cause→effect chains. Set when a follow-up
   *  event was triggered by an earlier one. */
  parentEventId?: string;
}

/** A single memory event, one JSON object per line in the JSONL store. */
export interface MemoryEvent {
  /** Schema version. Always equals MEMORY_SCHEMA_VERSION at write time. */
  v: number;
  /** Sortable id: `<ts-hex>-<random-hex>`. Lex order matches time order. */
  id: string;
  /** Unix epoch milliseconds. Mirrors the time prefix of `id`; kept
   *  separate for cheap numeric comparison without parsing. */
  ts: number;
  /** Project slug (lowercase, hyphens). Null for untagged events
   *  ("Untagged" rollup in dashboards). Inherited from the actor agent's
   *  `project` field at log time; explicit values override. Empty/missing
   *  is fine — never force-tag. */
  project: string | null;
  actor: MemoryActor;
  type: MemoryEventType;
  /** Human-readable one-line summary, capped at MEMORY_SUMMARY_MAX chars
   *  (truncated with "…" if exceeded). Long bodies belong in `payload`. */
  summary: string;
  /** Type-specific structured data. Shape varies by event type — see SCHEMA.md. */
  payload?: Record<string, unknown>;
  refs?: MemoryRefs;
}

/** Hierarchy-aware query. Field validity depends on `level`:
 *  - L0: no other fields used.
 *  - L1: `project` required.
 *  - L2: `project` and/or `date` (date alone → cross-project daily).
 *  - L3: `id` returns one event; otherwise filter by since/until/type/actor;
 *        `project` filters L3 too. */
export interface MemoryQuery {
  /** Hierarchy level. Default: L0. */
  level?: MemoryLevel;
  /** Required for L1. Filters L3 if provided. */
  project?: string;
  /** L2 only. ISO date "YYYY-MM-DD". */
  date?: string;
  /** L3 only — fetch a specific event by id. Bypasses other L3 filters. */
  id?: string;
  /** L3 only — inclusive lower bound on ts (epoch ms). */
  since?: number;
  /** L3 only — exclusive upper bound on ts (epoch ms). */
  until?: number;
  /** L3 only — restrict to event types. */
  type?: MemoryEventType[];
  /** L3 only — restrict to actor agent name (case-insensitive). */
  actor?: string;
  /** L3 only — max events to return. Default 100, hard cap 1000. */
  limit?: number;
}

/** memory_query response — discriminated by level.
 *  L0/L1/L2 return markdown content; L3 returns events. */
export type MemoryQueryResponse =
  | {
      level: "L0" | "L1" | "L2";
      /** Markdown body of the read file. Empty string if file does not exist
       *  yet (skeleton hasn't been provisioned). */
      content: string;
      /** Absolute path of the source file, for drill-down/edit follow-ups. */
      sourcePath: string;
    }
  | { level: "L3"; events: MemoryEvent[] }
  | { level: "L3"; event: MemoryEvent | null };
