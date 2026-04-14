# Cron Scheduler Design Document

**Date:** 2026-04-11
**Status:** Design complete, ready for implementation
**Author:** Terry Lu + design agent (collaborative session)

---

## Overview

Add a native cron scheduler to autonomOS so agents can run tasks on a recurring or one-time schedule. The scheduler runs server-side, persists schedules to disk, and integrates with the existing gateway, templates, and MCP tool systems.

**Key design principle:** Agents create schedules, the dashboard monitors and controls them.

---

## Architecture Summary

```
┌──────────────────────────────────────────────────────────┐
│  Dashboard (Schedules Pane)                              │
│  - View schedules, toggle enable/disable                 │
│  - "Run now" button, delete, run history                 │
│  - No create button — agents create via MCP              │
│  - maxConcurrentRuns setting                             │
└──────────────────┬───────────────────────────────────────┘
                   │ REST API
┌──────────────────▼───────────────────────────────────────┐
│  Server                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ routes/      │  │ scheduler.ts │  │ mcp/tools.ts   │  │
│  │ schedules.ts │  │ (Croner)     │  │ (6 new tools)  │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │           │
│         ▼                ▼                   ▼           │
│  ┌─────────────────────────────────────────────────┐     │
│  │ ~/.autonomos/schedules/<name>.json (config+state)│    │
│  │ ~/.autonomos/schedule-runs/<name>.jsonl (history) │    │
│  └─────────────────────────────────────────────────┘     │
│                          │                               │
│                          ▼                               │
│  ┌──────────────────────────────────────┐                │
│  │ Executors                            │                │
│  │  isolated: claude -p (child process) │                │
│  │  agent:<name>: gateway send()        │                │
│  └──────────────────────────────────────┘                │
└──────────────────────────────────────────────────────────┘
```

---

## Data Model

### Schedule File: `~/.autonomos/schedules/<name>.json`

One file per schedule. Config (user/agent-editable) + state (server-managed) in one file. Follows the templates pattern (`~/.autonomos/templates/<name>.json`).

```jsonc
{
  // ── Config (set by agents via MCP tools) ──────────────
  "name": "daily-github-summary",
  "description": "Summarize overnight GitHub activity",
  "schedule": "0 8 * * 1-5",              // 5-field cron OR "once:2026-04-15T09:00"
  "timezone": "America/Los_Angeles",       // IANA timezone, defaults to server local
  "target": "isolated",                    // "isolated" | "agent:<name>"
  "prompt": "Check GitHub notifications and summarize any overnight activity...",
  "template": "feature-worker",            // optional, for isolated mode
  "workingDirectory": "~/workspace/autonomOS",
  "autonomous": true,                      // default true
  "overlapPolicy": "skip",                // "skip" (default) | "allow" (v1). Future: "queue" | "cancel"
  "onComplete": "agent://Dispatcher",      // gateway URI, isolated mode only. Optional.
  "notify": "failure",                     // "always" | "failure" (default) | "never"
  "enabled": true,

  // ── State (server-managed, never set by agents) ───────
  "state": {
    "lastRunAt": "2026-04-11T08:00:03-07:00",
    "lastRunStatus": "success",            // "success" | "failure" | "running" | "skipped"
    "nextRunAt": "2026-04-14T08:00:00-07:00",
    "runCount": 42,
    "consecutiveFailures": 0,
    "currentRunId": null                   // non-null = currently running (used for overlap check)
  }
}
```

**Name validation:** `/^[a-z0-9][a-z0-9-]*$/` (same as templates — lowercase, hyphens, no path traversal).

**One-time schedules:** `"schedule": "once:2026-04-15T09:00"` — parsed by prefix. Auto-sets `enabled: false` after firing. If missed during downtime, fires once on startup catch-up, then disables.

### Run History: `~/.autonomos/schedule-runs/<name>.jsonl`

Append-only JSONL, one line per run. Auto-pruned at 2000 lines.

```jsonc
{"runId":"abc123","startedAt":"2026-04-11T08:00:03Z","completedAt":"2026-04-11T08:02:15Z","status":"success","target":"isolated","durationMs":132000,"error":null,"sessionId":null}
{"runId":"def456","startedAt":"2026-04-11T09:00:02Z","completedAt":"2026-04-11T09:00:07Z","status":"failure","target":"isolated","durationMs":5000,"error":"claude binary not found","sessionId":null}
{"runId":"ghi789","startedAt":"2026-04-11T10:00:00Z","completedAt":null,"status":"skipped","target":"isolated","durationMs":0,"error":"previous run still active (overlap: skip)","sessionId":null}
```

**Run statuses:** `success`, `failure`, `skipped`, `running`

**Output handling:** JSONL stores metadata only. For isolated mode, stdout is truncated to ~10KB in an `output` field. Full output stored separately at `~/.autonomos/schedule-runs/<name>/<runId>.out` if larger.

**sessionId:** For `agent:<name>` mode, references the target agent's session. For isolated mode, null (no dashboard session).

---

## Execution Modes

### Target: `"isolated"`

Lightweight, fire-and-forget execution. Spawns a headless process (initially `claude -p`, future: multi-provider agents like Codex, Gemini).

- No PTY, no dashboard presence
- Captures stdout/stderr
- Output stored in run history
- `onComplete` delivery: sends output to a gateway URI when done
- Template and workingDirectory configure the execution environment

**Note:** Isolated execution path ties into the multi-provider work. Initial implementation uses `claude -p`. The scheduler is target-agnostic — it calls an executor function that can be swapped.

### Target: `"agent:<name>"`

Inject a prompt into an existing running agent via `send()` through the gateway.

- Zero new resources — reuses an existing session
- If the named agent is not running → error, logged as a failed run
- No output capture (the agent handles the prompt in its own context)
- `onComplete` is not supported for this mode (agent manages its own output)

### Target: `"session"` (v2, deferred)

Spawn a full `createSession()` with PTY. Visible in sidebar. Deferred due to session accumulation problem (each fire creates a new sidebar entry).

---

## Scheduler Engine

### Library: Croner v10

- Zero dependencies, TypeScript-first
- Used by OpenClaw (`"croner": "^10.0.1"` in their package.json)
- Native `Intl` API for timezone handling (no luxon)
- Both scheduling mode and standalone `nextRun()` / `nextRuns(n)` computation
- npm: https://www.npmjs.com/package/croner
- GitHub: https://github.com/Hexagon/croner

### Timer Mechanism: Croner-Managed (not polling)

Each enabled schedule gets its own `Cron` instance. No polling loop — Croner fires callbacks at the right time via internal `setTimeout`.

```typescript
const activeJobs = new Map<string, Cron>();       // name → Croner instance
const runningRuns = new Map<string, RunState>();   // name → active run info
const runQueue: string[] = [];                     // names waiting for a concurrency slot
```

When a schedule is created/updated/deleted, the corresponding `Cron` instance is created/recreated/destroyed.

### Fire Callback Flow

```
onScheduleFired(schedule):
  1. Overlap check: is schedule.state.currentRunId non-null?
     → if overlapPolicy is "skip" and running: log skip to JSONL, return
     → if overlapPolicy is "allow": proceed regardless

  2. Concurrency check: are we at maxConcurrentRuns?
     → if yes: add to runQueue (FIFO), return
     → if no: proceed

  3. Dispatch execution:
     → isolated: spawn child process (claude -p or future multi-provider)
     → agent:<name>: send() via gateway router

  4. Track the run:
     → generate runId
     → set runningRuns.set(name, runState)
     → update schedule state: currentRunId, lastRunAt
     → append "running" entry to JSONL
     → persist schedule file to disk
```

### Run Completion Flow

```
onRunCompleted(name, result):
  1. Clear runningRuns entry
  2. Update schedule state:
     → lastRunStatus = result.status
     → consecutiveFailures: reset to 0 on success, increment on failure
     → currentRunId = null
     → recompute nextRunAt via Croner
  3. Append completion entry to JSONL
  4. If onComplete is set and target is isolated: send output via gateway
  5. If notify is "always" or ("failure" and status is failure): emit notification
  6. Drain runQueue: if anything queued, dispatch next
  7. Persist schedule file to disk
```

### Server Lifecycle

**Startup sequence** (in `index.ts`, after existing steps):

```
1. Validate claude binary          (existing)
2. Mount all routes                (existing)
3. Start HTTP server               (existing)
4. initGateway()                   (existing)
5. resumePersistedSessions()       (existing)
6. initScheduler()                 ← NEW: after sessions resume
```

Scheduler starts **after** sessions are up so `agent:<name>` targets can find their agents.

**`initScheduler()` does:**
1. Load all schedule files from `~/.autonomos/schedules/`
2. For each enabled schedule, create a `Cron` instance → add to `activeJobs`
3. Run catch-up check for missed runs

**Catch-up on startup:** For each enabled schedule, compare `Cron.previousRun()` to `state.lastRunAt`. If a run was missed during downtime, fire **one** catch-up (same as Claude Desktop). One-time schedules that missed their time also fire once.

**Graceful shutdown:**
1. Stop all `Cron` instances (no new fires)
2. Running executions continue to completion (they're child processes or gateway messages)
3. Persist current state to disk

### One-Time Schedule Handling

`"schedule": "once:2026-04-15T09:00"`:
- Parse the ISO datetime after the `once:` prefix
- Use `setTimeout` instead of a `Cron` instance
- When fired: dispatch run, then set `enabled: false` and persist
- If time is in the past on load: fire immediately (catch-up), then disable

---

## Overlap & Concurrency

### Per-Schedule: Overlap Policy

| Policy | Behavior | Implementation status |
|--------|----------|----------------------|
| `skip` | Don't start if previous run is active. Log as "skipped" in JSONL. | **v1** (default) |
| `allow` | Fire regardless of previous run state. | **v1** |
| `queue` | Buffer one pending run, execute when previous completes. | **v2** (reserved, errors with "not yet supported") |
| `cancel` | Gracefully stop previous run, start new. | **v2** (reserved) |

**Default: `skip`.** Industry standard (Temporal default, OpenClaw hardcoded behavior, Claude Desktop behavior). Safe for AI agents due to unpredictable runtimes and token cost.

**Skip detection:** `schedule.state.currentRunId !== null` → currently running → skip.

### Global: Max Concurrent Scheduled Runs

`maxConcurrentRuns` in `~/.autonomos/settings.json` under `scheduler`:

```jsonc
{
  "scheduler": {
    "maxConcurrentRuns": 3
  }
}
```

- Only governs scheduler-triggered runs. Manually spawned agents are unaffected.
- When limit is reached, excess runs enter a FIFO queue.
- Queue drains as runs complete. **Queued runs are never skipped** — this is a resource throttle, not a correctness policy.
- Default: 3.

---

## No Retry

When a scheduled run fails, it is logged as a failure with error details. **No automatic retry.** Rationale (from OpenClaw production experience): model/agent failures are typically configuration or setup issues. Retries burn tokens with the same result. The schedule will try again at the next cron tick naturally.

`consecutiveFailures` is tracked in state for potential future auto-pause behavior (like Inngest's "pause after 20 failures"), but no auto-pause is implemented in v1.

---

## MCP Tools (6 tools)

All schedule tools are available to all agents by default (no capability gating). Defined in `packages/server/src/mcp/tools.ts` alongside existing tools.

### `create_schedule`

Creates a new schedule. Errors if name already exists.

```typescript
{
  name: string,              // required, kebab-case
  schedule: string,          // required, cron expression or "once:..."
  target: string,            // required, "isolated" | "agent:<name>"
  prompt: string,            // required
  workingDirectory: string,  // required
  description?: string,
  timezone?: string,         // default: server local
  template?: string,
  autonomous?: boolean,      // default: true
  overlapPolicy?: string,    // default: "skip"
  onComplete?: string,       // gateway URI
  notify?: string,           // default: "failure"
  enabled?: boolean,         // default: true
}
```

### `list_schedules`

No parameters. Returns array of all schedules (config + state). Lightweight — no run history.

### `get_schedule`

`{ name: string }` — Returns full config + state + last 10 runs from JSONL.

### `update_schedule`

`{ name: string, ...partial config }` — Partial update. Only fields provided are merged. State section is untouched. Server recomputes `nextRunAt` if schedule/timezone changes. Errors if schedule doesn't exist.

### `delete_schedule`

`{ name: string }` — Removes the schedule file. Stops the Croner instance. JSONL run history is preserved for audit.

### `run_schedule`

`{ name: string }` — Triggers immediately, ignoring cron timing. Respects overlap policy (if `skip` and running, returns error). Respects `maxConcurrentRuns` (queues if at limit).

---

## REST API

Routes in `packages/server/src/routes/schedules.ts`.

| Method | Path | Description | MCP equivalent |
|--------|------|-------------|----------------|
| GET | `/api/schedules` | List all schedules | `list_schedules` |
| POST | `/api/schedules` | Create schedule | `create_schedule` |
| GET | `/api/schedules/:name` | Get one schedule | `get_schedule` |
| PUT | `/api/schedules/:name` | Partial update | `update_schedule` |
| DELETE | `/api/schedules/:name` | Delete schedule | `delete_schedule` |
| POST | `/api/schedules/:name/run` | Trigger now | `run_schedule` |
| GET | `/api/schedules/:name/runs` | Paginated run history | *(dashboard only)* |
| GET | `/api/scheduler/status` | Global scheduler state | *(dashboard only)* |
| PUT | `/api/scheduler/settings` | Update maxConcurrentRuns | *(dashboard only)* |

---

## Dashboard UI: Schedules Pane

A new pane type in the split-pane system, alongside OrgChart and Templates.

### Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Schedules                        2 running  ⚙ Max runs: [3] │
│ Created by agents · ask any agent to set one up              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ ● daily-github-summary                   ⏵ Run  🗑  │     │
│  │   Every weekday at 9:00 AM  ·  isolated             │     │
│  │   Last: ✓ 2h ago (34s)  ·  Next: Mon 9:00 AM       │     │
│  │   ▸ Run history (42 runs)                           │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ ● pr-review-nudge                        ⏵ Run  🗑  │     │
│  │   Every 30 min  ·  agent:ReviewLead                 │     │
│  │   Last: ✗ 12m ago (error)  ·  Next: in 18 min      │     │
│  │   ▸ Run history (108 runs)                          │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Key UX Decisions

1. **No create button.** Agents create schedules via MCP tools. Persistent subtitle educates: "Created by agents · ask any agent to set one up"
2. **Status dot toggles enable/disable.** `●` green = enabled, `○` gray = paused. Click to toggle.
3. **Human-readable cron** in the card, raw expression in tooltip.
4. **Inline run history.** Expand to see recent runs with status icons: ✓ success, ✗ failure, ⊘ skipped, ◉ running.
5. **Skipped runs are visible.** Important for debugging overlap behavior.
6. **maxConcurrentRuns** in the header. Also available in the general Settings popover (both surfaces).
7. **Active run indicator** in header: "2 running · 1 queued" when applicable.

### Empty State

```
┌──────────────────────────────────────────────────────────┐
│ Schedules                                   ⚙ Max runs: [3]│
│ Created by agents · ask any agent to set one up            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│                   No schedules yet                         │
│                                                            │
│       Schedules are created by agents using the            │
│       create_schedule tool. Ask any running agent:         │
│                                                            │
│       "Set up a daily GitHub summary at 9am"               │
│       "Schedule a weekly dependency audit"                 │
│       "Run a PR review check every 30 minutes"             │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## File Structure (new files)

```
packages/server/src/
  scheduler.ts                  # Scheduler engine (Croner, Map<string,Cron>, queue)
  schedules.ts                  # Schedule CRUD (read/write/delete schedule files)
  routes/schedules.ts           # REST API routes
  mcp/tools.ts                  # + 6 new tool definitions (shared)

packages/dashboard/src/
  components/SchedulesPanel.tsx  # Schedules pane UI

packages/core/src/types/
  schedule.ts                   # ScheduleConfig, ScheduleState, RunRecord types
```

---

## Future Work (not in v1)

- **`session` target mode** — Spawn full PTY sessions on schedule. Deferred due to session accumulation UX problem.
- **`queue` and `cancel` overlap policies** — Reserved in schema, error with "not yet supported" in v1.
- **Event-driven triggers (webhooks)** — Second automation type. When shipped, introduce "Automations" parent tab containing Schedules + Webhooks.
- **Multi-provider isolated execution** — Codex, Gemini, etc. as alternatives to `claude -p`. Ties into multi-provider agent work.
- **Auto-pause on consecutive failures** — Track `consecutiveFailures`, optionally pause after N. Schema supports it, behavior not implemented.
- **Budget controls** — `maxBudgetUsd` per run. Deferred — needs token tracking integration.
- **Notification integration** — `notify` field is in the schema. Delivery mechanism (dashboard notification panel, gateway message) TBD based on notification system work.

---

## Dependencies

- **Croner v10** (`croner`) — cron parsing and scheduling. Zero deps.
- **Existing systems:** gateway router (for `send()`), templates (for template resolution), settings (for `maxConcurrentRuns`), MCP tools (for shared definitions).
- **Multi-provider work** — Isolated execution path should coordinate with the multi-provider agent feature.

---

## References

- [Full research: Claude Code scheduling](./claude-code-scheduling.md) — three-tier model deep dive
- [Full research: Competitor landscape](./competitor-landscape.md) — Devin, Zo, Cursor, Temporal, n8n, etc.
- [OpenClaw source analysis](../openclaw/) — cron system internals, Croner usage, `runningAtMs` overlap guard
- Croner docs: https://github.com/Hexagon/croner
- Devin Scheduled Sessions: https://docs.devin.ai/product-guides/scheduled-sessions
- Temporal Schedules (overlap policies): https://docs.temporal.io/develop/typescript/workflows/schedules
