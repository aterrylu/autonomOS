## ADR-025: Fix restartAllSessions onExit Race Condition
**Date:** 2026-04-07
**Decided by:** Terry + BugFixes agent
**Source:** Claude Code session (discovered during PR #109 testing)

**Context:** `restartAllSessions()` sets `shuttingDown = true`, kills PTYs, calls `sessions.clear()`, then sets `shuttingDown = false` before respawning. PTY `onExit` handlers fire asynchronously — by the time they run, `shuttingDown` is already `false`, so they call `removePersistedSession()` which deletes entries that newly spawned sessions just wrote. Result: `sessions.json` ends up empty after restart-all.

**Decision:** Fix falls out of ADR-024 — `onExit` now sets `status: "exited"` instead of removing. No removal means no race. During `restartAllSessions()`, the new `createSession()` calls overwrite the exited entries via `persistSession()`'s upsert logic, so the status correctly becomes active again.

**Rationale:** Simplest fix that eliminates the race entirely rather than adding synchronization complexity.

**Alternatives:**
- **Track pending exits with a counter** — adds complexity, requires async coordination.
- **Check if session ID is still in the map before removing** — fragile timing dependency.
