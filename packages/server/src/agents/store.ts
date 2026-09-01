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
import {
  type Agent,
  type AgentStatus,
  buildTreeFromRecords,
  DEFAULT_PERMISSION_MODE,
  type ExitReason,
  isPermissionMode,
  type PermissionMode,
  type Provider,
  permissionModeFromLegacy,
  permissionModeFromStored,
  type UUID,
} from "@autonomos/core";
import { revokeAgentToken } from "../agentCredentials.js";
import { ensureConfigDir, getConfigDir } from "../configDir.js";
import { clearHandoffQueue } from "../handoffQueue.js";

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
  let migratedPermissionMode = 0;

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
      // Backfill `provider` for agent files that predate the field so the
      // non-optional `Agent.provider` contract stays honest. Without this a
      // legacy claude-code agent loads with `provider: undefined` and renders
      // as the generic "unknown provider" icon instead of its real mark.
      if (typeof data.provider !== "string") {
        data.provider = "claude-code";
      }
      // Accept-and-discard migration for two older shapes, newest first:
      //   1. `permissionMode: "default"` — this enum's pre-rename spelling of
      //      `ask`. Normalized so exactly ONE spelling exists past this line.
      //   2. `autonomousMode: boolean` — true preserved skip-permissions
      //      (→ bypass), false kept prompts (→ ask).
      // The guard is isPermissionMode (not just "is a string") so a malformed
      // or hand-edited value is coerced rather than trusted blindly into the
      // provider mappers. Scrub the old boolean; the cleaned record is written
      // back on the next saveAgent. See ADR-045 + the permission-mode refactor.
      const legacy = data as Agent & { autonomousMode?: boolean };
      if (!isPermissionMode(data.permissionMode)) {
        data.permissionMode =
          permissionModeFromStored(data.permissionMode) ??
          permissionModeFromLegacy(legacy.autonomousMode) ??
          DEFAULT_PERMISSION_MODE;
        migratedPermissionMode++;
      }
      if ("autonomousMode" in legacy) delete legacy.autonomousMode;
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

  if (migratedPermissionMode > 0) {
    console.warn(
      `[agents/store] migrated legacy 'autonomousMode' → 'permissionMode' on ` +
        `${migratedPermissionMode} agent record(s) (ADR-045). Old field scrubbed on next write.`,
    );
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

/** Resolve an agent by its provider (CC/Codex) session id — the id CC writes
 *  its JSONL under, NOT the internal agent UUID. Used by the resume-by-session
 *  path so a raw CC session id (e.g. one discovered via listSessions, or a
 *  migrated agent whose id != providerSessionId) maps back to its record.
 *  O(N) over a small in-memory cache; only hit on the resume/adopt path.
 *
 *  Multiplicity is handled rather than assumed away: nothing enforces
 *  `providerSessionId` uniqueness, and the ADR-049 safety net REGENERATES the
 *  field on a failed resume, so the id space isn't collision-free by
 *  construction. Returning `readCache()`'s first hit would make the winner
 *  filesystem-read order — arbitrary and unstable across restarts. Mirrors
 *  `resolveAgentByName`'s tie-break: prefer a running candidate, else the most
 *  recently updated. */
export function getAgentByProviderSessionId(
  providerSessionId: string,
): Agent | undefined {
  const matches = listAgents().filter(
    (a) => a.providerSessionId === providerSessionId,
  );
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

/** Record genuine agent activity (hook event / Codex turn) — the ONLY writer
 *  of `lastActivityAt`. Debounced: the in-memory record updates immediately
 *  (API reads see it), but disk flushes at most once per agent per
 *  ACTIVITY_FLUSH_MS unless `flush` forces it (turn boundaries) — a busy
 *  tool loop must not write a file per PostToolUse. Deliberately does NOT
 *  bump version/updatedAt: activity is not a record mutation, and bumping
 *  version here would churn optimistic-concurrency for every hook event.
 *  Unknown ids no-op (a hook can outlive its record). */
const ACTIVITY_FLUSH_MS = 30_000;
const lastActivityFlush = new Map<UUID, number>();
export function markActivity(
  id: UUID,
  ts: number = Date.now(),
  opts?: { flush?: boolean },
): Agent | undefined {
  const cache = readCache();
  const existing = cache.get(id);
  if (!existing) return undefined;
  // Monotonic — but a forced flush (turn boundary) must still persist a
  // same-millisecond value that only lives in memory (review: a Stop landing
  // in the same ms as its PostToolUse must not leave the turn-end memory-only).
  if (existing.lastActivityAt !== undefined && ts <= existing.lastActivityAt) {
    // Persist a memory-only value on a turn boundary — but if disk already
    // has it, skip: re-flushing would also re-emit a no-op delta upstream
    // (review: a same-ms Stop pushed an unchanged patch).
    if (opts?.flush && lastActivityFlush.get(id) !== existing.lastActivityAt)
      return flushActivity(id, existing);
    return undefined;
  }
  const next: Agent = { ...existing, lastActivityAt: ts };
  cache.set(id, next);
  const lastFlush = lastActivityFlush.get(id) ?? 0;
  if (opts?.flush || ts - lastFlush >= ACTIVITY_FLUSH_MS) {
    return flushActivity(id, next);
  }
  return undefined;
}

/** Best-effort durability: recency must never take down the hook-ingest
 *  pipeline (review: an ENOSPC here previously 500'd the POST and skipped
 *  status derivation for the event). The in-memory value is already updated;
 *  a failed flush costs durability only. Returns the record when the flush
 *  landed — callers use that to emit a push delta. */
function flushActivity(id: UUID, record: Agent): Agent | undefined {
  try {
    writeAgentFile(record);
    lastActivityFlush.set(id, record.lastActivityAt ?? Date.now());
    return record;
  } catch (err) {
    console.warn(`[agents] activity flush failed for ${id.slice(0, 8)}:`, err);
    return undefined;
  }
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
    Pick<
      Agent,
      | "name"
      | "template"
      | "project"
      | "permissionMode"
      | "providerThreadId"
      | "envPreset"
    >
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
  // Validate manager existence FIRST — even before the no-op short-circuit.
  // The dangling-ref scenario: a caller passes managerId === existing.managerId
  // where existing.managerId points to a manager that's been deleted from
  // disk but the in-memory cache hasn't been reloaded yet (rare, but reachable
  // via idempotent set_manager retries / stale UI / migration windows).
  // Without the up-front check, the no-op would silently re-affirm a dangling
  // pointer; the read-time scrub would then fix it on next loadAll, but the
  // write returned "success" in the meantime. Returning undefined surfaces
  // the missing manager to the caller so they can refetch and re-target.
  if (managerId !== null && !cache.has(managerId)) return undefined;
  if (managerId === id) return "cycle"; // self-loop can't be a no-op (id must exist)
  // No-op: managerId already matches AND has been validated above. Skip
  // write entirely (preserves version, no event, no cache divergence).
  if (existing.managerId === managerId) return existing;
  if (managerId !== null) {
    // Existence was checked above; only the ancestor walk remains.
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
  // Drop the per-agent credential (ADR-055 PR B). markExited is the single
  // chokepoint every exit path funnels through (onExit, kill, resume-failure,
  // restart-all), so revoking here guarantees a dead session's token can't be
  // replayed. A resume re-mints a fresh one via buildEnv. In-memory only, so
  // this never touches the durable record write below.
  revokeAgentToken(id);
  return saveAgent({
    ...existing,
    status: "exited" as AgentStatus,
    exitReason: existing.exitReason ?? reason,
    exitedAt: existing.exitedAt ?? Date.now(),
  });
}

/** Mark an agent as running (resume / re-attach). Clears exit metadata.
 *  `providerThreadId` is included so the resume-failure recovery path can reset
 *  a dead Codex thread in the same write that resets the session id (a patch
 *  value of `undefined` is dropped by saveAgent's JSON.stringify, clearing it). */
export function markRunning(
  id: UUID,
  patch: Partial<
    Pick<
      Agent,
      | "provider"
      | "providerSessionId"
      | "startedAt"
      | "providerThreadId"
      | "permissionMode"
      | "envPreset"
    >
  >,
): Agent | undefined {
  const cache = readCache();
  const existing = cache.get(id);
  if (!existing) return undefined;
  return saveAgent({
    ...existing,
    ...patch,
    // permissionMode is the one patchable field that is NON-optional on Agent,
    // so it can't use the "undefined clears it" convention the others rely on
    // (see the doc above): spreading `permissionMode: undefined` would drop the
    // key at saveAgent's JSON.stringify and silently demote the agent to the
    // fallback mode on its next load. Absent means "keep the record's value".
    //
    // It is patchable at all because a resume may carry an explicit mode that
    // differs from the record. Before this, markRunning could not express a
    // mode, so such a resume spawned the PTY with the caller's mode while the
    // record kept the old one — permanently. See ADR (permission-mode refactor).
    permissionMode: patch.permissionMode ?? existing.permissionMode,
    status: "running" as AgentStatus,
    exitReason: undefined,
    exitedAt: undefined,
  });
}

/** Hard delete an agent record. Returns true if removed.
 *  Caller is responsible for handling children — see deleteAgent in routes. */
export function deleteAgentRaw(id: UUID): boolean {
  lastActivityFlush.delete(id);
  const cache = readCache();
  if (!cache.has(id)) return false;
  try {
    rmSync(getAgentFile(id), { force: true });
  } catch (err) {
    console.error(`Failed to delete agent file ${id}: ${err}`);
    return false;
  }
  cache.delete(id);
  // Revoke here — the single chokepoint every delete path funnels through
  // (mirrors markExited's revoke for the exit paths). A record that ceases to
  // exist must take its credential with it, or the dying process's final hook
  // curls still verify and re-create the hook state the delete just reclaimed.
  // markExited cannot cover this: its not-found early-return fires when the
  // record is already gone.
  revokeAgentToken(id);
  // Same rationale as the token revoke: a record that ceases to exist takes its
  // associated state with it. Clear any hand-off queue so a deleted manual-queue
  // agent leaves no orphan file of undelivered messages behind. Best-effort +
  // wrapped like the rmSync above: the record is ALREADY gone from cache + disk
  // and the token revoked, so a throw here (unlink EACCES/EPERM, or a legacy id
  // that fails validateAgentId) must not turn a fully-succeeded delete into a
  // 500 that skips the route's post-delete work (nox review).
  try {
    clearHandoffQueue(id);
  } catch (err) {
    console.warn(
      `[store] failed to clear hand-off queue for ${id.slice(0, 8)}:`,
      err instanceof Error ? err.message : err,
    );
  }
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
 * - `includeExited`: when false (default), only agents with
 *   `status === "running"` are visible. Exited agents AND transient
 *   states (`starting`, etc.) are both filtered out. Their children
 *   become roots when their manager is filtered. This preserves the
 *   pre-refactor `buildOrgChartFromAgents` behavior — widening to
 *   `status !== "exited"` would be a user-visible API change for
 *   existing MCP/REST consumers.
 * - `mapNode`: projects each Agent to the consumer's preferred node shape
 *   (e.g. dashboard wants a `claudeSessionId` alias for legacy compat).
 */
export function buildAgentTree<
  N extends { id: string; children: N[] },
>(options: {
  includeExited?: boolean;
  mapNode: (a: Agent) => Omit<N, "children">;
}): N[] {
  // The filter/link algorithm lives in @autonomos/core (buildTreeFromRecords)
  // so the dashboard's socket-derived tree is the same code path as this one
  // — parity by construction. This wrapper only supplies the live records.
  return buildTreeFromRecords<N>(listAgents(), options);
}

// ── Helpers ────────────────────────────────────────────────────────

/** Build a fresh Agent record from spawn parameters. Does NOT persist. */
export function buildAgent(params: {
  id: UUID;
  name: string;
  workingDirectory: string;
  provider: Provider;
  providerSessionId: string;
  permissionMode: PermissionMode;
  template?: string;
  managerId?: UUID | null;
  project?: string;
  status?: AgentStatus;
  startedAt?: number;
  createdAt?: number;
  adoptedExternal?: boolean;
  envPreset?: string;
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
    permissionMode: params.permissionMode,
    status: params.status ?? "running",
    provider: params.provider,
    providerSessionId: params.providerSessionId,
    // Omitted entirely (not `false`/undefined) when unset so existing records
    // round-trip unchanged — same idiom as adoptedExternal.
    ...(params.envPreset ? { envPreset: params.envPreset } : {}),
    // Omitted entirely (not `false`) for non-adopted agents so existing records
    // round-trip unchanged.
    ...(params.adoptedExternal ? { adoptedExternal: true as const } : {}),
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
  lastActivityFlush.clear();
  agentsCache = null;
  lastReadFailed = false;
}
