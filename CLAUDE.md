# autonomOS — Agent Development Guide

## Start Here

1. Read [`README.md`](README.md) — project overview, monorepo structure
2. Read [`docs/FEATURES.md`](docs/FEATURES.md) — feature specifications and design intent
3. Read [`docs/DECISIONS.md`](docs/DECISIONS.md) — all architectural decisions with context and rationale
4. Read [`docs/ROADMAP.md`](docs/ROADMAP.md) — current priorities and what to work on
5. Read [`docs/RESEARCH.md`](docs/RESEARCH.md) — research findings, competitor analysis, learnings

## Project Vision

autonomOS is a **mission control platform for autonomous agents** — a terminal dashboard that spawns Claude Code sessions, tracks their status via hook telemetry, and enables multi-agent coordination through a messaging gateway.

**Current state:** Terminal dashboard + session management + hook relay + multi-agent gateway + MCP tools. The orchestrator/projects/workspaces model described below is the long-term vision, not yet implemented.

**Core concepts (future):**
- **Orchestrator** — PM agent, the main interface. Understands project goals, delegates to workspace agents, tracks progress.
- **Projects** — Logical goals with roadmaps. Can span multiple workspaces. Multiple projects per workspace.
- **Workspaces** — Physical repositories, auto-discovered. Each has active agent sessions.

Two paths that share a common core:
- **Dev Path** — control plane for agent tools (Claude Code, etc.)
- **Robot Path** — persistent agent platform for robotics (aspirational, future)

## Monorepo Structure

```
autonomOS/
├── packages/
│   ├── dashboard/          # Web UI — observability & control
│   │   └── src/layout/         # Binary tree split-pane system
│   ├── server/             # Hono + node-pty — API, WebSocket, PTY management
│   │   ├── src/gateway/        # URI-based message router + platform adapters
│   │   ├── src/channel-server/ # Standalone MCP subprocess (server:autonomos)
│   │   └── src/mcp/            # Shared MCP tool definitions (used by both servers)
│   └── core/               # Shared agent abstractions & types
├── docs/
│   ├── DECISIONS.md        # Architectural Decision Records (append-only)
│   ├── FEATURES.md         # Feature specifications (F-001 through F-016)
│   ├── ROADMAP.md          # Current priorities
│   ├── RESEARCH.md         # Research findings & competitor analysis
│   ├── VISION.md           # Project vision
│   └── research/           # Deep-dive research topics
├── CLAUDE.md               # This file — agent development guide
└── README.md               # Project overview
```

## Key Systems

### Hook Relay (`--settings` inline curl)
Every spawned session gets `--settings` with inline hook entries for all 13 Claude Code events. Each hook runs `curl -d @- $AUTONOMOS_SERVER/api/hooks/$SESSION_ID`. The server processes events for agent status tracking (`deriveStatus()` state machine) and notification generation (SendUserMessage, Stop, Notification, PermissionRequest).

**Events:** SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, Notification, PermissionRequest, SubagentStart, SubagentStop, PreCompact, PostCompact, SessionEnd

### Session Spawning Flags
Sessions are spawned with: `--session-id` (pre-generated UUID), `--brief` (enables SendUserMessage), `--append-system-prompt` (autonomOS context + MCP tool descriptions), `--settings` (hook relay), and optionally `--dangerously-skip-permissions` (autonomous mode), `--dangerously-load-development-channels` / `--channels`, and `--mcp-config` (channel server subprocess).

### Auto-Trust
`attachStartupWatcher()` monitors PTY output for Claude Code's interactive trust prompts and auto-dismisses them. Watches for "Yes, I trust this folder" and "WARNING: Loading development channels" needles after ANSI stripping. Each Enter is needle-verified (retry if the dialog re-renders or the PTY stays silent, capped attempts) because CC's TUI attaches its stdin handler 100-500ms after first paint — blind early writes get swallowed. Configurable via settings panel toggle (default: ON).

### Prompt Delivery Receipt (`agents/promptDelivery.ts`)
A starting prompt travels only as a CLI arg (`claude ... -- <prompt>`), so a startup-dialog race can silently drop it. Sessions spawned WITH a prompt are tracked through the hook stream: spawn → SessionStart → UserPromptSubmit confirms delivery. If SessionStart arrives but UserPromptSubmit doesn't within 20s, the prompt is re-delivered ONCE via PTY bracketed paste + Enter (any turn activity cancels — double-submission is worse than a manual nudge). No SessionStart within 15s → warning only. Failures surface as `SystemWarning` notifications in the dashboard notification panel.

### Agent Communication (URI-based)
Agents communicate via URI-based addressing through the gateway:
- `agent://name` — send to a named agent
- `broadcast://all` — send to all agents
- `discord://guild/channel`, `telegram://...`, `slack://...` — platform channels (when adapters ship)

The gateway router parses the URI scheme and delivers to the right destination.

### MCP Tool Architecture
Tool definitions live in `packages/server/src/mcp/tools.ts` — shared between:
- **HTTP MCP server** (`mcp.ts`) — served on the internal Unix control socket (`$configDir/control.sock`), NOT the public port (ADR-055). Reachable only by same-user processes on the box; a remote client would need a tunnel or a local forwarder. Still requires the auth token.
- **Channel MCP server** (`channel-server/`) — for autonomOS-spawned CC sessions

Both servers expose: `create_agent`, `list_agents`, `kill_agent`, `set_manager`, `get_org_chart`, `list_templates`, `create_template`, `self_exit`, `create_schedule`, `list_schedules`, `get_schedule`, `update_schedule`, `delete_schedule`, `run_schedule`. The channel server also has `send` (requires gateway WebSocket).

### Cron Scheduler (`scheduler.ts` + `schedules.ts`)
Native timer-based scheduling using Croner v10. Each enabled schedule gets its own `Cron` instance (no polling). Schedules stored as individual JSON files in `~/.autonomos/schedules/<name>.json` (config + state). Run history as append-only JSONL in `~/.autonomos/schedule-runs/<name>.jsonl` (auto-pruned at 2000 lines).

**Execution modes:**
- `isolated` — spawns headless `claude -p` child process, captures stdout/stderr, stores output in run history
- `agent:<name>` — sends prompt to a running agent via the gateway (`routeMessage`)

**Key behaviors:** Overlap policies (`skip` default, `allow`), global concurrency limits (`maxConcurrentRuns`, default 3, FIFO queue), startup catch-up for missed runs, one-time schedules (`once:ISO` format). Agents create schedules via MCP tools; the dashboard SchedulesPanel monitors and controls them (no create button in UI). REST API: `GET/POST /api/schedules`, `GET/PUT/DELETE /api/schedules/:name`, `POST /api/schedules/:name/run`, `GET /api/schedules/:name/runs`, `GET /api/scheduler/status`, `PUT /api/scheduler/settings`. See ADR-026.

### Agent Templates (`~/.autonomos/templates/`)
Reusable blueprints for creating agents. Individual JSON files with: `role`, `description`, `systemPrompt`, `capabilities`, `autonomousMode`, `model`. Created via `create_template` MCP tool or by dropping a `.json` file in the templates directory. Used via `create_agent(template: "team-lead", ...)`.

### Agent Hierarchy (Org Chart)
Hierarchy metadata (`template`, `manager`, `project`) is stored on persisted sessions in `sessions.json`. The org chart is derived at query time from `manager` references. Configured at runtime via `set_manager` MCP tool — agents or the human can organize the hierarchy after spawning. REST API: `GET /api/org`, `PUT /api/org/manager`, `GET/POST /api/templates`.

### Base Context Injection
Every autonomOS-spawned session gets `--append-system-prompt` with a `BASE_CONTEXT` constant covering:
1. **Identity** — agent is named, part of an organization, has manager/peers/reports
2. **Communication** — available MCP tools, async messaging, `from_uri` response pattern
3. **Environment** — dashboard observability, shared codebase, no direct terminal access between agents
4. **Lifecycle** — some agents are long-lived, others exit after a task. Sessions persist across restarts until ended by human, self, or manager

The tool list section interpolates `MCP_INSTRUCTIONS` from `mcp/tools.ts` (single source of truth). Use `--append-system-prompt` (preserves CC defaults + CLAUDE.md). Use `--system-prompt` only for full override.

## Key Conventions

### Decision Records (CRITICAL)
Every architectural decision goes in `docs/DECISIONS.md`. Append-only. Each entry must include:
- **Date** and **who decided** (human vs agent)
- **Context** — why this decision was needed
- **Decision** — what was chosen
- **Rationale** — why this over alternatives
- **Alternatives considered** — what else was evaluated
- **Source** — where the decision happened (Discord channel, CC session, etc.)

Never delete or modify past entries. If a decision is reversed, add a new entry referencing the old one.

### Research & Learnings
All research goes in `docs/RESEARCH.md` or `docs/research/` subdirectories. When investigating competitors, frameworks, or approaches:
- Document what you found with links
- Note what's relevant to autonomOS
- Include your assessment (not just raw info)

### Commit Messages
- `feat:` — new features
- `fix:` — bug fixes
- `perf:` — performance improvements
- `refactor:` — structural changes
- `docs:` — documentation changes
- `research:` — research findings
- `init:` — initial setup

### Terminology
- **UI says "agents"** — sidebar, buttons, labels
- **Code says "sessions"** — types, APIs, server internals
- Both refer to the same entity — a managed CC PTY process

### Session Naming
CC owns session names via JSONL `customTitle`. `titleCache.ts` reads them (256KB tail scan, mtime-cached). The `--name` flag sets the initial name at spawn. `/rename` updates it. The titleCache is more reliable than the SDK's `listSessions()` (which only reads 64KB).

### README Hero Image (keep it current)
The README's hero screenshot (`docs/assets/hero.png`) is generated, not hand-captured. It's produced by `make hero` (→ `packages/dashboard/scripts/capture-hero.ts`), which boots an isolated demo instance (own config dir + fake HOME + ephemeral port — never touches `:3100`), stages a multi-agent scene (org chart across Claude Code / Codex / Gemini, live terminals, both usage bars), and screenshots it via headless Chrome.

**If you change the dashboard UI, re-run `make hero` and commit the updated `docs/assets/hero.png`** — otherwise the front-page hero drifts from the real product. This applies to any visible change: layout/dockview, sidebar, org chart, status bar, terminal chrome, themes, provider icons, usage bars. The script header documents prerequisites (a `claude` binary; optional Codex/Gemini auth for those panes) and the capture-time tweaks it applies. Re-shoots are *similar, not pixel-identical* (the Codex/Claude turns are real).

### Development Philosophy
- **Personal tool first** — ship for Terry, generalize later
- **Both paths share core** — abstractions should work for dev agents AND robots

## What NOT to Do

- Don't make architectural decisions without recording them in DECISIONS.md
- Don't start building without checking ROADMAP.md for priorities
- Don't ignore existing research — check RESEARCH.md before investigating something
- Don't over-engineer for the robot path yet — it's aspirational
- Don't define MCP tool schemas directly in `mcp.ts` or `channel-server/index.ts` — they go in `mcp/tools.ts`
- Don't ship a visible dashboard UI change without re-running `make hero` — the README hero (`docs/assets/hero.png`) must reflect the real product

## Agent Workflow

When working on this repo:
1. Check ROADMAP.md — what's the current priority?
2. Check DECISIONS.md — has this been decided already?
3. Do the work
4. Update ROADMAP.md if priorities shifted
5. Add any new decisions to DECISIONS.md
6. Update RESEARCH.md with any new findings
