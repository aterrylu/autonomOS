/**
 * Agents store — per-file JSON persistence for autonomOS Agent records.
 *
 * Each agent lives at `~/.autonomos/agents/<id>.json`. This module owns
 * read/write/delete + integrity rules (cycle prevention, name uniqueness,
 * dangling-ref scrubbing). It does NOT own PTY lifecycle — that's runtime.ts.
 *
 * Storage layout: ~/.autonomos/agents/<id>.json (one file per agent)
 *
 * Safety:
 * - In-memory cache prevents read-modify-write races during concurrent mutations
 * - Per-file atomic writes (write to <id>.json.tmp + rename)
 * - Cycle check on setManager runs before write inside the in-memory snapshot
 * - Dangling managerId references are scrubbed at read time with a console.error
 *   so regressions surface in dev (the API enforces non-dangling at write time)
 */

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Agent,
  AgentStatus,
  ExitReason,
  Provider,
  UUID,
} from "@autonomos/core";
import { ensureConfigDir, getConfigDir } from "../configDir.js";

// ── Paths ──────────────────────────────────────────────────────────

export function getAgentsDir(): string {
  return join(getConfigDir(), "agents");
}

function getAgentFile(id: UUID): string {
  return join(getAgentsDir(), `${id}.json`);
}

/** Sentinel file written after migration finishes successfully. Migration
 *  uses this — not directory presence — to detect "already migrated".
 *  Otherwise a mid-migration crash that wrote the first agent file would
 *  permanently mark the dir as "migrated" and silently orphan the rest. */
export function getMigrationCompleteMarker(): string {
  return join(getAgentsDir(), ".migration-complete");
}

/** Touch the migration-complete sentinel. Idempotent — safe to call multiple times. */
export function markMigrationComplete(): void {
  ensureAgentsDir();
  writeFileSync(getMigrationCompleteMarker(), "", { mode: 0o600 });
}

/** Has the migration completed (or was this a fresh install)? */
export function isMigrationComplete(): boolean {
  try {
    return statSync(getMigrationCompleteMarker()).isFile();
  } catch {
    return false;
  }
}

function ensureAgentsDir(): void {
  ensureConfigDir();
  mkdirSync(getAgentsDir(), { recursive: true, mode: 0o700 });
}

// ── In-memory cache ────────────────────────────────────────────────
// All mutations go through the cache. loadFromDisk() populates it on
// first call; subsequent calls return the cached copy. Writes update
// both disk (atomically per-file) and the cache.

let agentsCache: Map<UUID, Agent> | null = null;
let lastReadFailed = false;

function loadFromDisk(): Map<UUID, Agent> {
  const dir = getAgentsDir();
  const map = new Map<UUID, Agent>();

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      // Dir doesn't exist yet — fresh install or pre-migration
      lastReadFailed = false;
      return map;
    }
    console.error(`Failed to read agents dir: ${err}`);
    lastReadFailed = true;
    return map;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry.endsWith(".tmp.json")) continue;
    const file = join(dir, entry);
    try {
      const raw = readFileSync(file, "utf-8");
      const data = JSON.parse(raw) as Agent;
      // Minimal shape validation — defensive against manual edits
      if (
        typeof data?.id !== "string" ||
        typeof data?.name !== "string" ||
        typeof data?.workingDirectory !== "string"
      ) {
        console.warn(`Skipping malformed agent file: ${entry}`);
        continue;
      }
      map.set(data.id, data);
    } catch (err) {
      console.warn(`Skipping unreadable agent file ${entry}: ${err}`);
    }
  }

  // Scrub dangling managerId refs as defense-in-depth.
  // The write-side enforces non-dangling, so this only fires on regression
  // or external mutation. console.error rather than silent so dev catches it.
  for (const agent of map.values()) {
    if (agent.managerId !== null && !map.has(agent.managerId)) {
      console.error(
        `[agents/store] agent ${agent.id} (${agent.name}) references missing manager ${agent.managerId} — scrubbing to null`,
      );
      agent.managerId = null;
    }
  }

  lastReadFailed = false;
  return map;
}

function readCache(): Map<UUID, Agent> {
  if (agentsCache === null) {
    agentsCache = loadFromDisk();
  }
  return agentsCache;
}

// ── Read API ──────────────────────────────────────────────────────

export function getAgent(id: UUID): Agent | undefined {
  return readCache().get(id);
}

/** All agents, regardless of status. Caller filters as needed. */
export function listAgents(): Agent[] {
  return Array.from(readCache().values());
}

/** Resolve an agent by display name (case-insensitive).
 *  Returns the running candidate if multiple share a name, otherwise the
 *  most recently updated. Returns undefined if no match. */
export function resolveAgentByName(name: string): Agent | undefined {
  const needle = name.toLowerCase();
  const matches = listAgents().filter((a) => a.name.toLowerCase() === needle);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  const running = matches.filter((a) => a.status === "running");
  const pool = running.length > 0 ? running : matches;
  let best = pool[0];
  for (const a of pool) {
    if (a.updatedAt > best.updatedAt) best = a;
  }
  return best;
}

/** Resolve agent by id-or-name. Always tries the O(1) cache.get() first
 *  before falling back to the O(N) name scan in resolveAgentByName, so
 *  UUID hits (the hot path for /api/agents/:id endpoints) stay constant-time. */
export function resolveAgent(idOrName: string): Agent | undefined {
  return readCache().get(idOrName) ?? resolveAgentByName(idOrName);
}

// ── Write API ──────────────────────────────────────────────────────

/** Thrown by writeAgentFile when the in-memory cache is known-stale
 *  (last `loadAll()` failed and the cache may be missing entries). The
 *  REST router catches this and maps it to 503 with a stable error code
 *  so dashboard/MCP clients can distinguish "server is in a degraded
 *  state, retry pointless until operator restarts" from a routine
 *  optimistic-concurrency miss or 500.
 *
 *  The single dedicated class lets every patchAgent / setManager /
 *  insertAgent / markExited / markRunning caller bubble this up
 *  naturally — Hono's onError() catches it once at the router level
 *  rather than every caller wrapping individually. */
export class CachePoisonedError extends Error {
  readonly code = "CACHE_POISONED" as const;
  constructor(message: string) {
    super(message);
    this.name = "CachePoisonedError";
  }
}

function writeAgentFile(agent: Agent): void {
  // Throw rather than silently return — callers update the in-memory cache
  // immediately after writeAgentFile() returns, so a silent skip causes the
  // cache to diverge from disk. Surfacing the error keeps the two in sync
  // and forces the operator to inspect the underlying load failure.
  if (lastReadFailed) {
    throw new CachePoisonedError(
      `Refusing to write agent ${agent.id} — last cache load failed (would risk data loss). Inspect ${getAgentsDir()} and restart.`,
    );
  }
  ensureAgentsDir();
  const finalPath = getAgentFile(agent.id);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(agent, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmpPath, finalPath);
}

/** Insert or update an agent. Bumps version + updatedAt automatically.
 *  For full-record writes (e.g. from migration). For partial updates from
 *  routes, prefer patchAgent / setManager / markExited / etc. */
export function saveAgent(agent: Agent): Agent {
  const next: Agent = {
    ...agent,
    updatedAt: Date.now(),
    version: agent.version + 1,
  };
  writeAgentFile(next);
  readCache().set(next.id, next);
  return next;
}

/** Insert a brand-new agent. Bypasses version bump (starts at 1). */
export function insertAgent(agent: Agent): Agent {
  const next: Agent = { ...agent, version: 1 };
  writeAgentFile(next);
  readCache().set(next.id, next);
  return next;
}

/** Patch a subset of mutable fields. Bumps version + updatedAt.
 *  Returns the new record, or undefined if id not found.
 *  If `expectedVersion` is provided and mismatches, returns "stale". */
export function patchAgent(
  id: UUID,
  patch: Partial<
    Pick<Agent, "name" | "template" | "project" | "autonomousMode">
  >,
  expectedVersion?: number,
): Agent | undefined | "stale" {
  const cache = readCache();
  const existing = cache.get(id);
  if (!existing) return undefined;
  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    return "stale";
  }
  return saveAgent({ ...existing, ...patch });
}

/** Set or clear an agent's manager. Cycle-checked.
 *  Returns the new record, "cycle" if the change would create one,
 *  "stale" on version mismatch, or undefined if id not found.
 *
 *  No-op short-circuit: if `managerId` already equals `existing.managerId`,
 *  return the existing record unchanged (no version bump, no disk write,
 *  no event). Catches genuine no-op caller flows — e.g. an MCP user
 *  invoking `set_manager(agent, current_parent)` or a UI re-issuing the
 *  same drag — so optimistic-concurrency tokens held by other clients
 *  aren't invalidated by a write that doesn't actually change state.
 *
 *  Note: this short-circuit does NOT cover the DELETE-with-reassignTo
 *  rollback path. During rollback `existing.managerId` is `newParent`
 *  (the post-forward state on disk) and the proposed value is the
 *  original — they differ, so the short-circuit is skipped and rollback
 *  WILL re-bump version on each restored child. That's accepted: a
 *  successful rollback is itself a meaningful state change worth
 *  signaling, and it's strictly preferable to the alternative (silent
 *  data loss when the rollback path is itself buggy). Callers holding
 *  stale version tokens for those children get a "stale" on retry,
 *  which is the correct signal. */
export function setManager(
  id: UUID,
  managerId: UUID | null,
  expectedVersion?: number,
): Agent | undefined | "cycle" | "stale" {
  const cache = readCache();
  const existing = cache.get(id);
  if (!existing) return undefined;
  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    return "stale";
  }
  // No-op: managerId already matches — skip write entirely (preserves version).
  if (existing.managerId === managerId) return existing;
  if (managerId !== null) {
    if (managerId === id) return "cycle";
    if (!cache.has(managerId)) return undefined; // unresolvable manager
    // Walk up the proposed parent's ancestor chain. If we hit `id`, cycle.
    let cursor: UUID | null = managerId;
    const seen = new Set<UUID>();
    while (cursor !== null) {
      if (cursor === id) return "cycle";
      if (seen.has(cursor)) break; // existing cycle (shouldn't happen, but stop)
      seen.add(cursor);
      const parent: Agent | undefined = cache.get(cursor);
      cursor = parent?.managerId ?? null;
    }
  }
  return saveAgent({ ...existing, managerId });
}

/** Mark an agent as exited (PTY died). Idempotent — first reason wins. */
export function markExited(id: UUID, reason: ExitReason): Agent | undefined {
  const cache = readCache();
  const existing = cache.get(id);
  if (!existing) {
    console.warn(`[agents/store] markExited: agent ${id} not found`);
    return undefined;
  }
  if (existing.status === "exited" && existing.exitReason) return existing;
  return saveAgent({
    ...existing,
    status: "exited" as AgentStatus,
    exitReason: existing.exitReason ?? reason,
    exitedAt: existing.exitedAt ?? Date.now(),
  });
}

/** Mark an agent as running (resume / re-attach). Clears exit metadata. */
export function markRunning(
  id: UUID,
  patch: Partial<Pick<Agent, "provider" | "providerSessionId" | "startedAt">>,
): Agent | undefined {
  const cache = readCache();
  const existing = cache.get(id);
  if (!existing) return undefined;
  return saveAgent({
    ...existing,
    ...patch,
    status: "running" as AgentStatus,
    exitReason: undefined,
    exitedAt: undefined,
  });
}

/** Hard delete an agent record. Returns true if removed.
 *  Caller is responsible for handling children — see deleteAgent in routes. */
export function deleteAgentRaw(id: UUID): boolean {
  const cache = readCache();
  if (!cache.has(id)) return false;
  try {
    rmSync(getAgentFile(id), { force: true });
  } catch (err) {
    console.error(`Failed to delete agent file ${id}: ${err}`);
    return false;
  }
  cache.delete(id);
  return true;
}

/** Get the ids of all agents that name `parentId` as their manager. */
export function childrenOf(parentId: UUID): Agent[] {
  return listAgents().filter((a) => a.managerId === parentId);
}

// ── Tree builder ───────────────────────────────────────────────────

/**
 * Build a parent→child tree from the agent collection. Shared between the
 * REST `/api/agents/tree` endpoint and the MCP `get_org_chart` tool so the
 * two views can never disagree on shape.
 *
 * - `includeExited`: when false (default), only `exited` agents are filtered
 *   out — transient states like `starting` and `running` are both visible.
 *   Their children become roots when their manager is filtered.
 * - `mapNode`: projects each Agent to the consumer's preferred node shape
 *   (e.g. dashboard wants a `claudeSessionId` alias for legacy compat).
 */
export function buildAgentTree<
  N extends { id: string; children: N[] },
>(options: {
  includeExited?: boolean;
  mapNode: (a: Agent) => Omit<N, "children">;
}): N[] {
  const all = listAgents();
  // Filter only exited (not just-running) so transient states like
  // `starting` still appear in the tree — matches the docstring's
  // promise and the operator mental model that "anything not exited
  // is something I might want to see."
  const visible = options.includeExited
    ? all
    : all.filter((a) => a.status !== "exited");
  const byId = new Map(visible.map((a) => [a.id, a]));
  const nodeById = new Map<string, N>();
  for (const a of visible) {
    // Construct the full node shape directly. The constraint
    // `N extends { id: string; children: N[] }` means
    // `Omit<N, "children"> & { children: N[] }` is structurally
    // identical to N — but TS's structural inference can't prove that
    // through a spread, so a single `as N` (without `as unknown`)
    // bridges the gap. Type-safe at the call site because
    // mapNode's return type IS Omit<N, "children">.
    const node = { ...options.mapNode(a), children: [] as N[] } as N;
    nodeById.set(a.id, node);
  }
  const roots: N[] = [];
  for (const a of visible) {
    const node = nodeById.get(a.id)!;
    const parent =
      a.managerId && byId.has(a.managerId)
        ? nodeById.get(a.managerId)
        : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Build a fresh Agent record from spawn parameters. Does NOT persist. */
export function buildAgent(params: {
  id: UUID;
  name: string;
  workingDirectory: string;
  provider: Provider;
  providerSessionId: string;
  autonomousMode: boolean;
  template?: string;
  managerId?: UUID | null;
  project?: string;
  status?: AgentStatus;
  startedAt?: number;
  createdAt?: number;
}): Agent {
  const now = Date.now();
  return {
    schemaVersion: 1,
    id: params.id,
    name: params.name,
    managerId: params.managerId ?? null,
    template: params.template,
    project: params.project,
    workingDirectory: params.workingDirectory,
    autonomousMode: params.autonomousMode,
    status: params.status ?? "running",
    provider: params.provider,
    providerSessionId: params.providerSessionId,
    startedAt: params.startedAt ?? now,
    createdAt: params.createdAt ?? now,
    updatedAt: now,
    version: 1,
  };
}

/** Has the agents/ dir been created? Used by migration to detect first-run. */
export function agentsDirExists(): boolean {
  try {
    return statSync(getAgentsDir()).isDirectory();
  } catch {
    return false;
  }
}

// ── Test hooks ────────────────────────────────────────────────────

/** For testing — clear the in-memory cache so the next read hits disk. */
export function _resetCacheForTesting(): void {
  agentsCache = null;
  lastReadFailed = false;
}
