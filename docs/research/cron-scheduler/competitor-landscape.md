# Competitor Landscape: Scheduling & Automation UIs

Survey of how AI coding tools and workflow platforms handle automation, scheduling, and recurring task execution. Focus on UI/UX patterns, with links to documentation and product pages.

---

## Devin (devin.ai) — Gold Standard

Devin has the most mature scheduling system of any AI coding agent.

### Scheduling Capabilities

**Scheduled Sessions:**
- Two schedule types: **Recurring** (cron-based) and **One-time** (specific date/time)
- Agent selection: Devin (standard) / Data Analyst / Advanced
- **Playbook attachment:** reusable `.devin.md` templates with structured sections (Procedure, Specifications, Advice, Forbidden Actions, Required from User)
- **Repository binding:** select one or more repos per schedule
- **Frequency editor:** Visual mode (hourly/daily/weekly presets) + Custom mode (raw cron expressions)
- **Timezone support:** local timezone input, stored as UTC
- **Email notifications:** Always / On failure only (default) / Never
- **Slack notifications:** post to a channel when schedules run
- **"Run as" user:** attribute runs to a specific team member, transferable
- **Schedule states:** Active / Paused / Error (auto-error after consecutive failures)

### UI/UX

**Two creation paths:**
1. From input box — type prompt, click three-dot menu, select "Schedule Devin"
2. From Settings > Schedules — dedicated management page

**Schedule list view:** name, frequency, last run time, status

**Task detail view:** full config with edit, run history

**Frequency editor:** two modes — Visual (dropdown presets) and Custom (cron expression text field)

**Session list in sidebar:** recent sessions with status indicators (Open, Merged), timestamps, brief descriptions

### Key Patterns to Adopt
- Two creation paths (inline + dedicated page)
- Visual + custom cron editor modes
- Template/playbook attachment to schedules
- Notification options with channel selection
- Auto-pause on consecutive failures
- One-time schedules auto-disable after execution

### Links
- Scheduled Sessions docs: https://docs.devin.ai/product-guides/scheduled-sessions
- Playbooks docs: https://docs.devin.ai/product-guides/creating-playbooks
- Skills docs: https://docs.devin.ai/product-guides/skills
- Session Insights: https://docs.devin.ai/product-guides/session-insights
- API Reference: https://docs.devin.ai/api-reference/overview
- Homepage: https://devin.ai/

---

## Zo Computer (zo.computer) — Conversational Automations

Zo is the rebranded OpenClaw ("Personal agent — the original OpenClaw"). A personal AI cloud computer you interact with via chat (web, desktop, iMessage, Telegram, Discord, Slack, email).

### Scheduling Capabilities

Dedicated **Automations** sidebar tab — first-class navigation alongside Home, Files, Chats, Space, Skills.

- One-time future execution or recurring intervals
- Jobs have access to files, integrations, and all AI tools
- Conversational creation: tell Zo what to do and when in natural language
- **Conditional notifications:** "text me only if this product is on sale"
- Delivery via SMS or email
- Example use cases: daily news summaries, habit reminders, website monitoring with alerts, follow-up email composition

### UI/UX

- Automations created **conversationally** — no form, just describe what you want
- Dedicated sidebar tab (not buried in settings)
- "Runs 24/7, even while you sleep"
- Integrations with all messaging platforms as bidirectional channels

### Key Patterns to Adopt
- Automations as a first-class sidebar item
- Conversational creation flow as an alternative to forms
- Conditional notifications (with threshold/criteria)
- Multi-platform delivery (SMS, email, Slack, Discord)

### Links
- Homepage: https://www.zo.computer/
- Automations docs: https://docs.zocomputer.com/automations
- Skills docs: https://docs.zocomputer.com/skills
- YouTube (demos): https://www.youtube.com/@zo-computer
- Discord: https://discord.gg/invite/zocomputer
- GitHub: https://github.com/zocomputer/Zo

---

## Cursor (cursor.com) — No Scheduling, Great Agent Dashboard

Cursor 3 (April 2026) focuses on cloud agents but has **no scheduling or cron features** — a surprising gap. What's relevant is their agent management UX.

### Agent Dashboard

- **Sidebar shows all agents** — local and cloud, from all sources (mobile, web, desktop, Slack, GitHub, Linear)
- **State-based grouping:** "IN PROGRESS" (with count) and "READY FOR REVIEW" (with count)
- **Agent cards:** name, time, diff stats (+/-), status message, last activity
- **Artifact-based review:** screenshots, demos, video recordings, live previews — not just diffs
- **Cloud-to-local handoff:** move a running agent between environments seamlessly

### Research: Self-Driving Codebases
- Multi-agent orchestration with thousands of agents in parallel
- Roles: executor agents, integrator agents
- "35% of PRs we merge internally are now created by agents"

### Key Patterns to Adopt
- State-based grouping in sidebar (In Progress / Ready for Review)
- Artifact-based review (screenshots, demos, logs)
- Agent handoff between environments

### Links
- Product page: https://cursor.com/product
- Cursor 3 announcement: https://cursor.com/blog/cursor-3
- Self-driving codebases: https://cursor.com/blog/self-driving-codebases
- Self-hosted cloud agents: https://cursor.com/blog/self-hosted-cloud-agents
- Cloud Agents (requires login): https://cursor.com/agents
- Changelog: https://cursor.com/changelog

---

## GitHub Actions — Baseline for Run History

The industry standard for CI/CD with cron scheduling.

### Scheduling
- `schedule` event trigger with 5-field cron expressions
- Minimum interval: 5 minutes (practical: ~15 min due to load)
- **UTC-only** (no timezone support)
- YAML-defined in `.github/workflows/*.yml`
- Multiple cron entries per workflow

### UI/UX
- **Actions tab:** all workflow runs in a list with status (success/failure/in-progress), commit, branch, actor, timestamp
- **Sidebar filters:** by workflow name, status, branch, actor
- **Run detail view:** step-by-step execution timeline with expand/collapse
- **Manual trigger:** "Run workflow" button with optional input parameters
- **Workflow visualization:** graph view showing job dependencies
- **No visual cron editor** — YAML only

### Key Patterns to Adopt
- Run history list with status icons and filterable columns
- Expandable detail view with execution timeline
- "Run workflow" manual trigger button
- Status badges (green check, red X, yellow dot)

### Key Gaps
- No visual cron editor
- UTC-only, no timezone support

### Links
- Schedule trigger docs: https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule

---

## Temporal (temporal.io) — Overlap Policies

Durable execution platform with the most sophisticated scheduling model.

### Key Concepts

**Schedule API:**
- Intervals (`every: '10s'`)
- Calendar-based schedules (day of week, hour, minute)
- One-time datetime schedules

**Overlap Policies (critical for agent scheduling):**

| Policy | Behavior |
|--------|----------|
| `SKIP` | Don't start new run if previous is still running |
| `BUFFER_ONE` | Queue one pending run, skip additional |
| `ALLOW_ALL` | Run in parallel |
| `CANCEL_OTHER` | Cancel the previous run, start new one |

**Catchup Windows:** how far back to go for missed runs (configurable duration)

**Backfill:** retroactively run schedules for past time ranges

**Schedule CRUD:** create, backfill, delete, describe, list, pause, trigger, update

### Key Patterns to Adopt
- Overlap policies — MUST have for agent scheduling
- Catchup windows (configurable, not just "one most recent")
- Pause/resume as first-class operations
- Backfill capability

### Links
- Homepage: https://temporal.io/
- TypeScript Schedules: https://docs.temporal.io/develop/typescript/workflows/schedules

---

## n8n (n8n.io) — Visual Workflow Automation

"AI agents and workflows you can see and control." Open-source (with licensing caveats), node-based.

### Scheduling
- **Schedule Trigger node:** supports seconds/minutes/hours/days/weeks/months intervals plus custom cron
- Multiple trigger rules can be stacked
- Part of a visual workflow — schedule triggers feed into processing nodes

### UI/UX
- **Node-based visual editor** with drag-and-drop canvas
- Schedule Trigger is a "node" that starts a workflow
- **9,166+ community templates** searchable by category
- **Execution history** with detailed per-node logs

### Key Patterns
- Visual node-based editor for workflow composition
- Community template library
- Per-node execution history

### Links
- Homepage: https://n8n.io/
- Schedule Trigger docs: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/
- Workflow templates: https://n8n.io/workflows/

---

## Inngest (inngest.com) — Durable Cron Functions

"Make any code durable by default." Code-first workflow orchestration.

### Scheduling
- Code-defined cron schedules with **timezone support:** `cron: "TZ=Europe/Paris 0 12 * * 5"`
- Cron defined directly in function definitions (code-first, not UI-first)
- Fan-out pattern for scheduled tasks
- **Auto-pause after 20 consecutive failures** (free plan)

### Key Patterns
- Timezone-aware cron expressions
- Auto-pause on consecutive failures (safety mechanism)
- Code-first schedule definition

### Links
- Homepage: https://www.inngest.com/
- Crons docs: https://www.inngest.com/docs/guides/scheduled-functions

---

## Windsurf (Codeium) — No Scheduling

AI code editor (VS Code fork) with Cascade agent. Has **no scheduling, automation, or recurring task features**. Purely synchronous coding assistant. Not relevant for scheduling design.

### Links
- Homepage: https://windsurf.com

---

## Other Tools (Brief Notes)

- **Sweep AI** — Now JetBrains-only plugin. No scheduling.
- **SWE-agent / aider** — CLI tools, no scheduling UI.

---

## Synthesis: Patterns for autonomOS

### Must-Have Patterns

| Pattern | Source | Why |
|---------|--------|-----|
| Dedicated "Schedules" page | Devin, Zo | First-class feature, not buried in settings |
| Visual + custom cron editor | Devin | Presets for common cases, raw cron for power users |
| Template attachment | Devin (playbooks) | Reuse agent configs across schedules |
| Run history with status icons | GitHub Actions | Baseline expectation for any scheduling UI |
| "Run now" button | Devin, Claude Code | Essential for testing and debugging |
| Pause/resume toggle | Devin, Claude Code, Temporal | Don't force delete-and-recreate |
| Overlap policies | Temporal | Critical: what if previous run is still going? |
| Notification options | Devin | Always / On failure / Never, with channel selection |

### Should-Have Patterns

| Pattern | Source | Why |
|---------|--------|-----|
| Conversational creation | Zo | Natural alternative to forms for agent users |
| Two creation paths (inline + page) | Devin | Meet users where they are |
| Auto-pause on consecutive failures | Inngest | Safety against runaway token spend |
| Timezone-aware cron | Inngest, Devin | Users think in local time |
| Catchup window configuration | Temporal | More flexible than "one most recent" |
| State-based grouping | Cursor | Group scheduled runs by state in sidebar |

### Our Unique Advantages

| Advantage | What It Enables |
|-----------|----------------|
| Three execution modes | Isolated + inject + session in one dropdown |
| Gateway integration | `send()` results to other agents or platform channels on completion |
| Org chart awareness | Schedule team leads who spawn workers |
| Hook telemetry | Tool usage, tokens, errors per run — nobody else has this |
| Template system | Richer than Devin's playbooks (roles, capabilities, MCP config) |
