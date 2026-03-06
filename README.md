# autonomOS

A mission control platform for autonomous agents — observe, configure, and orchestrate agents across development tools and robotics.

## What is this?

autonomOS is a control plane that sits above agent runtimes (like [OpenClaw](https://github.com/openclaw/openclaw), Claude Code, and others) to provide:

- **Terminal-first** — Claude Code sessions in high-quality embedded terminals (iTerm2/VSCode quality)
- **Observability** — see what your agents are doing, token spend, context utilization, session history
- **Scheduling** — cron, git events, webhooks, and agent chains to automate Claude Code sessions
- **Orchestration** — manage multiple sessions, coordinate agents, track costs across projects
- **Git-native** — deep worktree integration, PR tracking, branch-aware sessions

## Features

Detailed feature specs with priorities, design notes, and critical path in **[docs/FEATURES.md](docs/FEATURES.md)**.

| Priority | Feature | Description |
|----------|---------|-------------|
| **P0** | [Desktop Shell](docs/FEATURES.md#f-001-desktop-application-shell) | Application container — Electron vs Tauri vs web. **Decision needed first.** |
| **P0** | [Terminal View](docs/FEATURES.md#f-002-terminal-view) | High-quality xterm.js terminal as the primary Claude Code interface |
| **P0** | [Real-Time Streaming](docs/FEATURES.md#f-016-real-time-streaming) | Event infrastructure — Claude CLI subprocess to UI |
| **P1** | [Chat View](docs/FEATURES.md#f-003-chat-view) | Structured conversation view of the same session (alternative to terminal) |
| **P1** | [Session Discovery](docs/FEATURES.md#f-004-session-discovery--management) | Find all sessions — spawned by autonomOS + running in external terminals |
| **P1** | [Multi-Session Dashboard](docs/FEATURES.md#f-005-multi-session-dashboard) | Home screen showing all active/recent sessions at a glance |
| **P1** | [Agent Scheduling](docs/FEATURES.md#f-006-agent-scheduling--automation) | Cron, git events, webhooks, agent chains |
| **P1** | [Session History](docs/FEATURES.md#f-008-session-history--search) | Browse and search past sessions with full-text search |
| **P1** | [Git/Worktree Integration](docs/FEATURES.md#f-009-git--worktree-integration) | Worktree-aware sessions, PR tracking, branch context |
| **P2** | [Cost Tracking](docs/FEATURES.md#f-007-cost-tracking--analytics) | Per-session, per-model, time-series cost analytics |
| **P2** | [Provider Abstraction](docs/FEATURES.md#f-010-provider-abstraction-layer) | API layer for Claude Code / Gemini CLI / OpenCode |
| **P2** | [File Browser](docs/FEATURES.md#f-011-file-browser) | Read-only file tree for session context |
| **P3** | [Agent Profiles](docs/FEATURES.md#f-012-agent-profiles--rules) | Reusable agent config templates (model, permissions, cost limits) |
| **P3** | [Integrations Dashboard](docs/FEATURES.md#f-013-integrations-dashboard) | View connected MCP servers and integration health |
| **P3** | [Mobile Access](docs/FEATURES.md#f-014-mobile--remote-access) | Tool approval notifications from phone |

## Two Paths

### Dev Path (Starting Here)
A Claude Code wrapper and control plane — terminals, scheduling, observability, and orchestration for coding agents.

### Robot Path (Aspirational)
A persistent agent platform for robotics — agents that interface with joint control, sensor inputs, and run continuously. Inspired by [dimensionalOS](https://github.com/dimensionalOS/dimos).

Both paths share the same core: persistent agents, orchestration, and observability.

## Status

Research and architecture phase. Next blocker: **[F-001 Desktop Shell decision](docs/FEATURES.md#f-001-desktop-application-shell)**.

## Docs

- **[FEATURES.md](docs/FEATURES.md)** — Full feature specs, priorities, and critical path
- **[DECISIONS.md](docs/DECISIONS.md)** — Architectural decision records
- **[RESEARCH.md](docs/RESEARCH.md)** — Competitor analysis and research findings
- **[VISION.md](docs/VISION.md)** — Project vision and principles
- **[ROADMAP.md](docs/ROADMAP.md)** — Milestone planning (will update after F-001 decision)

## Structure

```
packages/
  dashboard/    # Web UI — observability & control
  core/         # Shared agent abstractions & types
docs/
  FEATURES.md   # Feature specs (the development guide)
  DECISIONS.md  # Architectural decisions (append-only)
  RESEARCH.md   # Research findings
  research/     # Deep dives on competitors and frameworks
```

## License

TBD
