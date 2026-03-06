# CC-Insights V2

**Type:** Integration target / reference implementation -- interactive agent control plane
**Repo:** Local checkout at `~/workspace/cc-insights/` (private, GPLv3)
**Version studied:** v0.1.2 (commit `670a8d6`, local checkout)
**Researched:** 2026-03-05

## What It Is

CC-Insights is a **Flutter desktop application (macOS)** for monitoring and interacting with Claude Code agents via the SDK. Unlike mission-control (which scans `~/.claude/projects/` for session JSONL), CC-Insights **spawns Claude Code as a subprocess** and communicates via stdin/stdout JSON streaming. This makes it a full **interactive control plane**, not just an observer.

The codebase is substantial: ~498 Dart files, ~194K lines, organized into 5 modules (frontend, agent_sdk_core, claude_dart_sdk, codex_dart_sdk, acp_dart_sdk). It supports three agent backends (Claude CLI, OpenAI Codex, Anthropic Compute Platform) through a unified `EventTransport` abstraction.

## Why We Care

CC-Insights solves the **interactive session control** problem that mission-control doesn't touch. Where MC is "Grafana for agents" (observe + scan), CC-Insights is more like "iTerm for agents" (spawn + control + observe).

| Need | CC-Insights Provides | Gap |
|------|---------------------|-----|
| Session interaction | Full bidirectional: send messages, approve permissions, answer questions | Only sessions it spawns (no external session discovery) |
| Real-time streaming | 100% event-driven via subprocess stdout, no polling | Desktop-only, no web API surface |
| Cost tracking | Per-model, per-chat, per-worktree, project-wide aggregation | No cross-project dashboard, no time-series charts |
| Context window | Live tracking with autocompact threshold awareness | Single-session view only |
| Git integration | Deep: worktree create/manage, branch ops, conflict detection | No PR creation API (uses `gh` CLI) |
| Task management | Built-in ticket system with timeline, tags, dependencies, graph view | No external integration (GitHub Issues, Linear, etc.) |
| Multi-backend | Claude CLI + Codex + ACP via unified interface | Adding new backends requires Dart SDK work |
| Agent orchestration | Subagent tracking (spawn/complete events, read-only conversations) | No multi-agent coordination beyond what Claude does natively |
| License | GPLv3 | Copyleft -- cannot import code into MIT/proprietary autonomOS |

## Investigation Checklist

- [x] Architecture overview -- monorepo layout, SDK layers, transport abstraction
- [x] Session discovery -- spawns CLI subprocess, no external session scanning
- [x] Data extraction -- InsightsEvent sealed hierarchy (13+ event types, 100+ types total)
- [x] Real-time streaming -- 100% event-driven, no polling
- [x] Session interaction -- full bidirectional: messages, permissions, questions, interrupts
- [x] Analytics/metrics -- token usage, cost, context window, timing stats
- [x] Dashboard -- table-based drill-down (project > worktree > chat), no charting
- [x] Task management -- built-in ticket system with 60+ files
- [x] Git/GitHub integration -- deep worktree service, branch management
- [x] Transport architecture -- EventTransport abstraction designed for remote backends
- [x] Extension points -- AgentBackend, AgentSession, EventTransport interfaces
- [x] Licensing -- GPLv3 copyleft

## Deep Dives

- **[architecture.md](architecture.md)** -- Codebase layout, module structure, transport layers, data flow
- **[data-model.md](data-model.md)** -- InsightsEvent hierarchy, token tracking, persistence format, metrics
- **[session-interaction.md](session-interaction.md)** -- Bidirectional control, permission system, session lifecycle
- **[autonomos-integration.md](autonomos-integration.md)** -- What to learn from, what to reimplement, integration strategy
- **[licensing.md](licensing.md)** -- GPLv3 analysis and implications

## Key Numbers

| Metric | Value |
|--------|-------|
| Source files | ~498 Dart files |
| Lines of code | ~194K lines |
| Frontend files | ~395 (Flutter) |
| SDK modules | 4 (agent_sdk_core, claude_dart_sdk, codex_dart_sdk, acp_dart_sdk) |
| Event types | 13+ InsightsEvent subtypes |
| Backend commands | 9+ BackendCommand types |
| Public types | ~111 in agent_sdk_core |
| Service files | ~46 |
| Model files | ~20 |
| Ticket-related files | ~60 |
| Test files | ~60+ widget/unit/integration |
| Agent backends | 3 (Claude CLI, Codex, ACP) |
| License | GPLv3 (copyleft) |

## Assessment for autonomOS

**Relevance: HIGH** -- CC-Insights is the best reference for interactive agent session control. Its architecture (especially `EventTransport` and `InsightsEvent`) validates the approach autonomOS should take.

**Key insight:** CC-Insights and mission-control solve complementary halves of the problem. MC scans existing sessions for passive observability; CC-Insights spawns and controls sessions interactively. autonomOS needs both -- passive discovery of running sessions AND interactive control of spawned ones.

**Integration constraint:** GPLv3 means we **cannot import CC-Insights code** into autonomOS (MIT/proprietary). We can study patterns and reimplement. The type system design (sealed hierarchies for events/commands) and transport abstraction pattern are the highest-value takeaways.

**Comparison with Mission Control:**

| Capability | Mission Control | CC-Insights | autonomOS Needs |
|-----------|----------------|-------------|-----------------|
| Session discovery | Scans ~/.claude/projects/ JSONL | Spawns subprocess | Both |
| Session interaction | Read-only | Full bidirectional | Bidirectional |
| Tech stack | Next.js + SQLite | Flutter desktop | Web (Next.js/SvelteKit) |
| Multi-agent | Via OpenClaw gateway | Subagent events | Full orchestration |
| Cost tracking | Per-session, Recharts | Per-model, tables only | Time-series + aggregation |
| Task management | Kanban board (6 columns) | Built-in ticket system | Integrate with existing wt-plan workflow |
| Git integration | Minimal | Deep (worktrees, branches, conflicts) | Deep |
| API surface | 64 REST + SSE | None (desktop only) | REST + WebSocket + SSE |
| License | MIT | GPLv3 | MIT preferred |
