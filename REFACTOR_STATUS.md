# Hierarchy Refactor — Status & Hand-off

**Branch:** `terry/hierarchy-refactor`
**Status:** WIP — server-side foundation in place; client + wiring + tests + ship still pending
**Last updated:** 2026-05-04

This document hands off implementation state from the design conversation to whoever
finishes the PR. The full design rationale lives in the conversation transcript;
this file is the executable plan.

## Why this refactor

After server restart (`make prod` / `make deploy`), the dashboard's hierarchy view
sometimes shows fewer agents than the flat view. Root cause: hierarchy is modeled
as a *projection* over PTY sessions keyed by mutable name strings, with `/api/sessions`
and `/api/org` computing the same answer through different filters that drift.

**Fix:** unify on a single canonical `Agent` entity, ID-keyed manager refs, one
endpoint, WebSocket deltas, per-file JSON storage. Both dashboard views derive
their shape on the client from the same payload — disagreement becomes impossible
by construction.

## Architectural decisions (locked)

| Decision | Choice |
|---|---|
| Canonical entity | `Agent` (in `@autonomos/core`, `types/agent.ts`) |
| Storage | Per-file JSON at `~/.autonomos/agents/<id>.json` (no DB) |
| ID model | `agent.id === old claudeSessionId` for migrated agents (Option A) |
| Status field | `"running" \| "exited"` (no archived/detached today) |
| Manager refs | `managerId: UUID \| null` — ID-keyed, rename-proof |
| Single endpoint | `/api/agents` REST + `/ws/agents` deltas |
| WS events | 6 past-tense single-word events + `reconcile` (see `core/types/agent.ts`) |
| Component | `OrgChart.tsx` (rename of `HierarchyPanel.tsx`) |
| Migration | Server-startup, idempotent, process-manager-agnostic |
| Schema versioning | `schemaVersion: 1` per file |
| MCP tool surface | Unchanged (continue accepting names; resolve to ids at boundary) |

## What's done in this branch

### Phase 1 — Core types ✅
- `packages/core/src/types/template.ts` (NEW) — `AgentTemplate`, `AgentCapability` moved here
- `packages/core/src/types/agent.ts` (REWRITTEN) — `Agent` entity, `AgentEvent` union, `Provider`/`AgentStatus`/`ExitReason`/`UUID` types
- `packages/core/src/index.ts` (MODIFIED) — exports both modules

### Phase 2 — Agents store ✅
- `packages/server/src/agents/store.ts` (NEW)
- File IO with in-memory cache, atomic per-file writes (`.tmp` + rename)
- Integrity rules: cycle prevention, dangling-ref scrubbing, name resolution
- Public API: `getAgent`, `listAgents`, `resolveAgentByName`, `resolveAgent`, `insertAgent`, `saveAgent`, `patchAgent`, `setManager`, `markExited`, `markRunning`, `deleteAgentRaw`, `childrenOf`, `buildAgent`, `agentsDirExists`

### Phase 3 — Migration ✅
- `packages/server/src/agents/migrate.ts` (NEW)
- `migrateIfNeeded()` — idempotent server-startup migration
- Reads `sessions.json`, writes per-agent files, renames source to `.premigration-<ISO>` on success
- Handles dup-name canonicalization (prefer running, newest persistedAt)
- Manager name → managerId resolution

### Phase 4 — Agents runtime ✅
- `packages/server/src/agents/runtime.ts` (NEW) — replaces `sessions.ts`
- `spawnAgent`, `killAttachment`, `deleteAgent`, `shutdownAllAttachments`, `resumeActiveAgents`, `restartAllAttachments`, `resolveAgentId`
- Emits `agent.created` / `agent.attached` / `agent.exited` / `agent.deleted` events at the right lifecycle points

### Phase 5 — Event bus + WS broadcaster ✅
- `packages/server/src/events/agents.ts` (NEW) — typed in-process emitter
- `packages/server/src/ws/agents.ts` (NEW) — WebSocket router for `/ws/agents`, sends `reconcile` on connect, broadcasts deltas

### Phase 6 — REST routes ✅
- `packages/server/src/routes/agents.ts` (NEW) — replaces `routes/sessions.ts` and `routes/hierarchy.ts`
- Endpoints: GET `/`, GET `/:id`, POST `/`, PATCH `/:id`, POST `/:id/manager`, POST `/:id/attach`, POST `/:id/kill`, DELETE `/:id` (with `?reassignTo` and `?force`)
- Cycle check + optimistic concurrency via `If-Match` header

## What's left

### Phase 7 — MCP + gateway updates ⚠️ NOT STARTED
Update the following files to use the new `agents/store.ts` + `agents/runtime.ts`:
- `packages/server/src/mcp.ts` — `set_manager`, `get_org_chart`, `create_agent`, `kill_agent`, `list_agents`, `self_exit`. Tool surface unchanged for users; internally resolve names → ids via `resolveAgentByName` before mutations.
- `packages/server/src/channel-server/index.ts` — same set of tools; channel server proxies to the HTTP API.
- `packages/server/src/gateway/router.ts` — `agent://name` resolution via `resolveAgentByName` instead of the old `getAllSessions().find(...)` pattern.
- `packages/server/src/scheduler.ts` — `agent:<name>` target resolution similarly.
- `packages/server/src/routes/projects.ts` — replace `getPersistedSessions()` reads with `listAgents()` reads.

For `get_org_chart` MCP tool: keep building the nested tree server-side (for MCP clients that can't compose trees), using `listAgents()` + the same `byManagerMap` logic the dashboard uses.

### Phase 8 — Wire `index.ts` ⚠️ NOT STARTED
Update `packages/server/src/index.ts`:
1. Replace `import { getPersistedSessions, markSessionExited } from "./persisted.js"` with imports from `agents/store.ts`.
2. Replace `import { ... shutdownAllSessions } from "./sessions.js"` with `agents/runtime.ts` imports.
3. Add migration call BEFORE `serve()` opens the listener:
   ```ts
   import { migrateIfNeeded } from "./agents/migrate.js";
   import { ensureAgentsDir } from "./agents/store.js";
   // before serve():
   const migrationResult = migrateIfNeeded();
   console.log(`[startup] migration: ${JSON.stringify(migrationResult)}`);
   ```
4. Mount new routes in place of old:
   ```ts
   import { agentsRouter } from "./routes/agents.js";
   import { agentsRouter as agentsWsRouter } from "./ws/agents.js";
   // ...
   app.route("/api/agents", agentsRouter);
   // delete: app.route("/api/sessions", sessionRouter);
   // delete: app.route("/api/org", orgRouter);
   app.get("/ws/agents", agentsWsRouter(upgradeWebSocket));
   ```
5. `resumePersistedSessions()` → `resumeActiveAgents()` from `agents/runtime.ts`.
6. `shutdownAllSessions()` → `shutdownAllAttachments()` from `agents/runtime.ts`.

### Phase 9 — Client store ⚠️ NOT STARTED
- Create `packages/dashboard/src/store/agents.ts` — slice with `agents: Record<UUID, Agent>`, `applyEvent`, `reconcile`, plus selectors: `selectActive`, `selectExited`, `selectRoots`, `selectByManager`.
- Create `packages/dashboard/src/hooks/useAgentsStream.ts` — WebSocket subscription hook with reconnect-and-reconcile.
- Update `packages/dashboard/src/store.ts` — remove `sessions`/`exitedSessions`/`fetchSessions` (or thin them to call selectActive/selectExited from the new slice). Drop the session-fingerprint trigger.

### Phase 10 — Client UI ⚠️ NOT STARTED
- Rename `HierarchyPanel.tsx` → `OrgChart.tsx` and refactor to consume `selectRoots` + `selectByManager` from the new store. Drop `useOrgChart` (the local fetch hook).
- Surgery on `Sidebar.tsx` (1750 lines):
  - Both flat and hierarchy view consume the new selectors.
  - Delete `useOrgChartData` (the local fetch hook with refresh-key trigger).
  - Delete `mergeOrgWithSessions` import + usage.
  - Delete `HierarchyFallbackNotice` (the bug it papered over becomes impossible).
  - The `hierarchyOrder` (drag-reorder per-group) state stays in localStorage, applied at render time on top of `selectByManager` output.
- Update `App.tsx` if it references `HierarchyPanel` (search for the import).

### Phase 11 — Tests ⚠️ NOT STARTED
- `packages/server/src/__tests__/agents-store.test.ts` — cycle rejection, name resolution, atomic write, dangling-ref scrubbing
- `packages/server/src/__tests__/migration.test.ts` — realistic `sessions.json` fixture → per-file output; idempotency; name-collision canonicalization
- Delete: `packages/server/src/__tests__/orgChart.test.ts`, `packages/dashboard/src/components/Sidebar.mergeOrgWithSessions.test.ts`

### Phase 12 — Cleanup ⚠️ NOT STARTED
Delete (only after all consumers are updated):
- `packages/server/src/orgChart.ts`
- `packages/server/src/persisted.ts`
- `packages/server/src/sessions.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/server/src/routes/hierarchy.ts`
- `packages/dashboard/src/components/mergeOrgWithSessions.ts`

Then run `make check` — must be clean.

### Phases 13–17 — Polish, QA, ship, monitor, merge ⚠️ NOT STARTED
Per established memory:
- `/polish` (3 review agents) — required before ship
- `/qa` (real spawn, exercise all 6 events end-to-end against `make dev`, NOT prod) — required BEFORE ship
- `/ship` (commit, push, PR with mermaid diagrams)
- Monitor CI; address comments
- `gh pr merge --squash` (NEVER `--admin`)
- `mcp__autonomos__self_exit`

## Acceptance test for the bug fix

Single end-to-end test that should exist before merge:

```
1. Spawn 5 agents with a hierarchy (1 root, 2 children, 2 grandchildren)
2. Restart the dev server
3. Wait for resumeActiveAgents() to complete
4. Assert: selectActive(store).length === number-of-agent-rows-rendered-in-hierarchy-view
```

This is the test that should have existed before this entire investigation.

## Risks to watch during finish-up

| Risk | Mitigation |
|---|---|
| `routes/projects.ts` still references `getPersistedSessions()` | Phase 7 must update or `make check` will fail |
| `gateway/router.ts` `getAllSessions()` import dies when sessions.ts deletes | Phase 7 must port the agent:// resolution to use `listAgents()` |
| `scheduler.ts` `agent:<name>` resolution dies similarly | Same |
| `Sidebar.tsx` is 1750 lines of inter-twined logic | Approach as a sequence of small commits within the worktree, not one giant rewrite |
| Migration doesn't run on a fresh install (no `sessions.json`) | `migrateIfNeeded()` returns `"no-source"` cleanly; just call `ensureAgentsDir` separately to make sure the dir exists |

## Files in this WIP commit

New (server):
- `packages/server/src/agents/store.ts`
- `packages/server/src/agents/migrate.ts`
- `packages/server/src/agents/runtime.ts`
- `packages/server/src/events/agents.ts`
- `packages/server/src/ws/agents.ts`
- `packages/server/src/routes/agents.ts`

New (core):
- `packages/core/src/types/template.ts` (`AgentTemplate` moved here)

Modified:
- `packages/core/src/types/agent.ts` (rewritten with new `Agent` entity)
- `packages/core/src/index.ts` (export both)

Untouched (still in use, will be deleted in Phase 12):
- `packages/server/src/sessions.ts`
- `packages/server/src/persisted.ts`
- `packages/server/src/orgChart.ts`
- `packages/server/src/routes/sessions.ts`
- `packages/server/src/routes/hierarchy.ts`
- `packages/dashboard/src/components/mergeOrgWithSessions.ts`
- `packages/dashboard/src/components/HierarchyPanel.tsx`

## Why no behavioral change yet

The new files in this commit are not wired into anything. `index.ts` still
mounts the old routes. The dashboard still polls `/api/sessions` and
`/api/org`. The bug isn't fixed in this commit — but the foundation is in
place and verified compilable.

To complete: Phase 7 (MCP/gateway updates) → Phase 8 (`index.ts` wiring) →
Phase 9-10 (client) → Phase 11-12 (tests + cleanup) → Phase 13-17 (polish/qa/ship/merge).
