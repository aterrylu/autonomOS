# Claude Code Scheduling: Three-Tier Deep Dive

How Claude Code implements scheduling and recurring tasks across three durability tiers.

---

## Tier 1: Session-Scoped (CronCreate / CronList / CronDelete)

### What It Is

Three built-in tools that implement in-memory cron scheduling within a single Claude Code session. Any agent can call them — no permission required.

### Data Model

Each task has:
- **8-character task ID** (used for referencing/deleting)
- **5-field cron expression** (minute, hour, day-of-month, month, day-of-week)
- **Prompt** to execute on each fire
- **Recurring flag** (recurring vs one-shot)
- All times in **local timezone**, not UTC

### Execution Model

- Scheduler **checks every second** for due tasks
- Enqueues at **low priority** — never preempts user interaction
- Tasks fire **between turns** (not while Claude is mid-response)
- **No catch-up** for missed fires — fires once when idle, not once per missed interval
- **50 task maximum** per session
- All storage is **in-memory only**

### Cron Expression Support

Supports: wildcards (`*`), single values (`5`), steps (`*/15`), ranges (`1-5`), comma-separated lists (`1,15,30`).

NOT supported: `L`, `W`, `?`, name aliases like `MON` or `JAN`.

When both day-of-month and day-of-week are constrained, a date matches if **either** field matches (standard vixie-cron semantics).

### Jitter

- **Recurring tasks:** fire up to 10% of their period late, capped at 15 minutes
- **One-shot tasks:** near `:00` or `:30` fire up to 90 seconds early
- **Offset is deterministic** — derived from task ID, not random. Same task always gets the same offset
- Prevents thundering herd without unpredictability

### Safety

- **7-day auto-expiry** on recurring tasks (fires one final time, then self-deletes)
- **Disable flag:** `CLAUDE_CODE_DISABLE_CRON=1` kills the scheduler entirely
- One-shot tasks auto-delete after firing

### Agent Programmability

Fully programmable. Any agent calls `CronCreate` with a cron expression, prompt, and recurring flag. No permission approval needed. `CronList` returns all tasks with IDs, schedules, and prompts. `CronDelete` cancels by ID.

Cannot schedule work for another session — tools are session-scoped only.

---

## The /loop Command (Wraps Tier 1)

`/loop` is a bundled skill (prompt-based, not built-in) that provides a user-friendly interface for recurring execution.

### Three Modes

| Input | Behavior |
|-------|----------|
| Interval + prompt | Fixed schedule via CronCreate (`/loop 5m check deploy`) |
| Prompt only | Dynamic self-pacing — Claude chooses delay each iteration |
| Nothing | Built-in maintenance prompt OR custom `loop.md` |

### Fixed Interval Mode

Converts human-friendly intervals (e.g., `5m`, `2h`, `30s`) to cron expressions. Seconds rounded up to nearest minute. Creates a standard CronCreate task underneath.

### Dynamic Self-Pacing Mode (ScheduleWakeup)

When interval is omitted, Claude **picks its own delay** (1 min to 1 hour) after each iteration based on what it observed:
- Short waits while builds are finishing or PRs are active
- Longer waits when nothing is pending
- **Cache-awareness**: staying under 5 min keeps the Anthropic prompt cache warm (~$0 reads). Sleeping past 300s means uncached reads — slower and more expensive.
- The `<<autonomous-loop-dynamic>>` sentinel is the internal mechanism for passing the loop prompt between iterations

On Bedrock/Vertex/Foundry: dynamic mode falls back to a **fixed 10-minute schedule**.

### Built-in Maintenance Prompt (Bare `/loop`)

When no prompt is given, runs these tasks in order:
1. Continue any unfinished work from the conversation
2. Tend to current branch's PR: review comments, failed CI, merge conflicts
3. Run cleanup passes (bug hunts, simplification) when nothing else is pending

Claude does NOT start new initiatives outside this scope.

### `loop.md` Customization

- `.claude/loop.md` (project-level, takes precedence)
- `~/.claude/loop.md` (user-level)
- Plain markdown, no required structure
- Replaces the built-in maintenance prompt for bare `/loop`
- Max 25,000 bytes (truncated beyond that)
- Edits take effect on next iteration (live reload)

---

## Tier 2: Desktop Scheduled Tasks (Persistent, Local)

### What It Is

Persistent scheduled tasks that run on the user's local machine via the Claude Code Desktop app. Survive app restarts.

### Storage

Tasks stored at `~/.claude/scheduled-tasks/<task-name>/SKILL.md` with YAML frontmatter:
```yaml
---
name: task-name
description: What this task does
---

[Prompt markdown body here]
```

**Important quirk:** Schedule, model, enabled state, and permission mode are **NOT in the SKILL.md** — the Desktop app manages that separately in its own internal state. The SKILL.md only stores name, description, and prompt.

### Execution Model

- Desktop checks schedules **every minute** while the app is open
- Each task gets a **deterministic stagger of up to 10 minutes** after scheduled time (based on task, for API traffic smoothing)
- When a task fires: desktop notification + new session in "Scheduled" sidebar section
- Each run creates a **fresh, independent session**
- Tasks only run while **Desktop app is running and computer is awake**

### Missed-Run Catch-Up

- On app start or computer wake, checks if tasks missed runs in the last 7 days
- If missed: starts exactly **ONE catch-up run** for the most recently missed time
- A daily task that missed 6 days runs once on wake — not 6 times
- Shows a notification when catch-up starts

### Per-Task Permission Modes

Each task has its own permission mode, set at creation time. If a task hits an unapproved tool, the run stalls until you approve. Tip from docs: click "Run now" after creating, approve permissions with "always allow", and future runs auto-approve.

### Worktree Support

Optional toggle gives each run its own isolated git worktree.

### UI/UX

**Creation flow:**
- Schedule page > "New task" > "New local task"
- Form fields: name (kebab-case), description, prompt, model selector, permission mode, working directory, worktree toggle, frequency (Manual / Hourly / Daily / Weekdays / Weekly)

**Task detail page:**
- "Run now" button
- Pause/resume toggle
- Edit all settings
- Run history (every past run, including skipped ones)
- "Always allowed" panel — see and revoke saved tool approvals
- Delete (removes task, archives sessions)

### Limitations

- Requires Desktop app running and computer awake
- "Keep computer awake" setting exists but closing laptop lid still sleeps
- Schedule/model/enabled state not in SKILL.md — must be changed through UI or conversational command

---

## Tier 3: Cloud Scheduled Tasks (Persistent, Anthropic-Managed)

### What It Is

The most durable option. Tasks run on Anthropic-managed cloud infrastructure (VMs), persisting indefinitely regardless of whether your computer is on.

### Execution Model

- Each run creates a **fresh cloud VM** (~4 vCPU, 16 GB RAM, 30 GB disk)
- Repository is **cloned fresh** from GitHub each run (starts from default branch)
- Claude creates `claude/`-prefixed branches for changes (configurable to allow unrestricted)
- Runs are **fully autonomous** — no permission prompts
- Pre-installed: Python, Node.js, Ruby, PHP, Java, Go, Rust, C/C++, Docker, PostgreSQL, Redis
- MCP connectors (Slack, Linear, Google Drive, etc.) attachable per task

### Three Creation Surfaces

All manage the same backing store:

**1. Web UI (`claude.ai/code/scheduled`):**
- "New scheduled task" button opens multi-step form
- Fields: task name, prompt (with model selector), repo selector, branch permissions, environment config (network access, env vars, setup script), schedule picker (presets: Hourly/Daily/Weekdays/Weekly + time picker), MCP connectors
- Task detail page shows past runs as **clickable sessions** — open to see what Claude did, review diffs, create PRs, continue conversation
- "Run now" button, pause/resume toggle, edit, delete

**2. Desktop app:**
- Schedule page > "New task" > "New remote task"
- Same fields as web UI

**3. CLI (`/schedule` skill):**
- Conversational setup: `/schedule` walks you through name, prompt, repos, environment, schedule, connectors
- Subcommands: `/schedule list`, `/schedule update` (for custom cron), `/schedule run`
- Requires GitHub authentication

### Schedule Options

| Frequency | Description |
|-----------|-------------|
| Hourly | Every hour |
| Daily | Once per day at specified time (default 9:00 AM local) |
| Weekdays | Daily but skips Sat/Sun |
| Weekly | Once per week on specified day/time |

**Minimum interval: 1 hour.** Custom cron only via CLI (`/schedule update`), not the web UI.

### Environment Configuration

Named environments with:
- Network access level (None / Trusted / Full / Custom)
- Environment variables (.env format, visible to editors)
- Setup script (bash, runs as root before session)
- No dedicated secrets store yet

### Results and Delivery

- Each run creates a **new session** in the sidebar (alongside manual sessions)
- Can open any run to see what Claude did, review diffs, create PRs, continue the conversation
- Desktop notifications when tasks fire
- **No webhook/callback mechanism** for completion notifications
- **No inter-agent messaging** — scheduled runs can't `send()` results to other agents

---

## Cross-Tier Comparison

| Property | CronCreate | Desktop Tasks | Cloud Tasks |
|----------|-----------|---------------|-------------|
| Persistence | In-memory | Disk (SKILL.md) | Cloud |
| Min interval | 1 min | 1 min | 1 hour |
| Expiry | 7 days | None | None |
| Max tasks | 50 | Unlimited | Unlimited |
| Needs machine on | Yes (session) | Yes (app) | No |
| Needs session open | Yes | No | No |
| Local file access | Yes | Yes | No (fresh clone) |
| Jitter | Deterministic (ID-based) | 10-min stagger | Per-task offset |
| Permission prompts | Inherits session | Per-task mode | None (autonomous) |
| Agent-creatable | Yes (tool call) | Partially (SKILL.md) | Yes (/schedule) |
| Catch-up on miss | No | 1 most recent | N/A (always running) |
| Worktree support | No | Yes (toggle) | N/A (fresh clone) |

---

## Gaps Relevant to autonomOS

| Gap | Description | autonomOS Opportunity |
|-----|-------------|----------------------|
| No public REST API | Scheduling is UI/skill-only, no programmatic CRUD | Expose schedules via REST API + MCP tools |
| No completion webhook | Can't notify external systems when a run finishes | Gateway integration: `send()` on completion |
| No inter-agent scheduling | Can't schedule work for another agent | `target: "agent:<name>"` mode |
| Split metadata | SKILL.md has prompt, app has schedule/model/enabled | Single source of truth per schedule file |
| No overlap policy | No handling for "previous run still going" | Temporal-style policies (skip/queue/cancel) |
| Limited cron in UI | Web only has presets, CLI needed for custom cron | Visual cron editor + custom expression input |
| No run telemetry | No tool usage, token costs, or error rates per run | Hook telemetry already collected |

---

## Design Insights for autonomOS

1. **Three tiers is the right model.** Session-scoped for active work, persistent for server-managed recurring tasks, and (future) cloud for infrastructure. autonomOS maps to the persistent tier — the server is always running.

2. **Deterministic jitter over random jitter.** Derive offsets from task ID/name for consistent, debuggable timing without thundering herd.

3. **Self-pacing is powerful.** Letting agents choose their own polling interval based on observed state is more token-efficient than fixed intervals. Relevant for monitoring tasks.

4. **Per-task configuration.** Different tasks need different autonomy levels, models, templates, and working directories.

5. **One catch-up run, not many.** When recovering from missed runs (e.g., server restart), replay just the most recent. Prevents avalanche.

6. **"Run now" is essential.** Every scheduled task needs an immediate-trigger button for testing and debugging.

7. **Pause/resume, not delete-and-recreate.** Users should be able to temporarily disable a schedule without losing its configuration.

8. **Run history as clickable sessions.** Past runs should link to their output/sessions for inspection.
