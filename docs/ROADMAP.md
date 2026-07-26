# Roadmap

Last updated: 2026-04-14

## Done

- [x] Repo structure, conventions, CLAUDE.md
- [x] Research: dimensionalOS, Zo Computer, Mission Control, LM Studio, YepAnywhere, amux
- [x] Tech stack decided: React + Zustand + Tailwind + Hono + node-pty (ADR-007–010)
- [x] Server: Hono + node-pty, spawns Claude Code sessions via PTY
- [x] Dashboard: xterm.js terminal view with WebSocket streaming
- [x] Session management: sidebar, create/switch/kill, auto-reconnect with output buffer replay
- [x] Themes: Midnight, Daylight, Void (Pitch Black)
- [x] Zustand persist, single store (ADR-011)
- [x] CI: GitHub Actions, Biome, TypeScript project references
- [x] Mobile-responsive layout (visualViewport for keyboard handling, responsive sidebar overlay)
- [x] Project browser — Claude SDK listSessions() grouped by directory
- [x] Resume existing sessions — click project session to resume or switch to live
- [x] Production serving — Hono serves built dashboard with SPA fallback
- [x] Security hardening — CORS, input validation, path traversal checks, optional token auth
- [x] Core loop verified (spawn → interact → reconnect → resume)
- [x] JSONL title cache — workaround for SDK `customTitle` 64KB bug (mtime-cached JSONL parsing)
- [x] Live/project session sync — green dots, name propagation
- [x] Plugin system — modular architecture with VSCode-style status bar (ADR-013)
- [x] Claude Usage plugin — rate limit tracking via claude.ai API (ADR-013)
- [x] Instant terminal switching — VSCode-style keep-alive, no flash on switch (ADR-015)
- [x] xterm.js 6 upgrade — native synchronized output support (flicker-free rendering)
- [x] Auto-persist sessions — survive server restarts, PM2 daemon mode
- [x] Settings panel — configure API keys, channels, auto-trust toggle
- [x] Markdown preview — shipped (ADR-018), then removed 2026-07-25 after silently regressing (ADR-059)
- [x] Codicon icons — VSCode-style iconography throughout UI
- [x] Drag-to-reorder — reorder sessions in sidebar
- [x] Simplified Makefile — dev/prod split, PM2 daemon, remote deployment via rsync
- [x] Research: agent platform design (ADR-019–022) — folder model, session model, context assembly, audience types
- [x] Research: multi-agent landscape — Jinn, Marc Nuri, Claudia, ccswarm, multiclaude, OpenSwarm
- [x] Session naming — `basename · shortId` default, `/rename` tracked via JSONL title cache
- [x] Split-pane layout — binary tree system, drag-to-split, keyboard shortcuts (Ctrl+D/Shift+D/W/B) (#40)
- [x] Pane groups — sessions split together form named/colored groups with collapse/expand (#40, #56)
- [x] Hook relay — zero-config telemetry via `--settings` inline curl, 13 CC hook events (#48, #55)
- [x] Agent status icons — real-time CSS-animated status derived from hook events (#54, #60)
- [x] Notification badges — unread count per agent, auto-clear when focused (#48, #61, #62, #93)
- [x] SendUserMessage / --brief integration — structured agent-to-dashboard messaging (#81, #83)
- [x] `--session-id` flag — pre-generated UUID eliminates PTY regex race condition (#63, #69)
- [x] `--append-system-prompt` — base autonomOS context + per-agent instructions injected at spawn (#85, #86)
- [x] Channel system — `--dangerously-load-development-channels` + `--channels` from settings (#52, #72)
- [x] Channel MCP server — standalone subprocess (server:autonomos) bridging MCP to gateway (#72, #86)
- [x] HTTP MCP server — Streamable HTTP transport at `/mcp` for external clients (#82, #86)
- [x] MCP tools — `send`, `list_agents`, `create_agent`, `kill_agent` with shared definitions (#82, #85, #86)
- [x] Gateway WebSocket — URI-based message router (`agent://`, `broadcast://`) (#72, #82)
- [x] Auto-trust — auto-dismiss workspace trust + dev channels prompts on session start (#94)
- [x] PWA — installable standalone app + desktop notifications (#71)
- [x] Conversation view — structured chat transcript with TUI styling (#53)
- [x] Mobile touch scroll — inertial scrolling with momentum/flick (#44, #45)
- [x] Terminal auto-focus — sidebar click focuses terminal via rAF polling registry (#93)
- [x] Tier 1 perf — CSS spinner, polling equality guards, useShallow, rAF debounce (#88)
- [x] Documentation overhaul — README, CLAUDE.md, AGENTS.md updated for current state (#96)
- [x] Cron scheduler — Croner-based scheduling engine, 6 MCP tools, REST API, dashboard Schedules pane, isolated + agent execution modes (ADR-026)

## Now — Polish & Daily Driver

Fix rough edges blocking daily use as the primary agent management tool.

- [ ] Notification panel — slide-from-top panel showing SendUserMessage content with timestamps
- [ ] Tier 2 perf — replace polling with gateway WebSocket push (eliminate 20 req/min)
- [ ] Token spend / cost tracking per session (extend claude-usage plugin)
- [ ] Agent activity dashboard (what's running, what failed, timeline view)

## Next — Orchestrator Foundation

Evolve from passive dashboard to orchestrator-first platform (ADR-012).

- [ ] Rename "Projects" → "Workspaces" in UI (repos are workspaces, not projects)
- [ ] Project model — logical goals with status, roadmap, linked workspaces
- [ ] Orchestrator chat — main page becomes a conversation with the PM agent
- [ ] Agent runner — reads `agent.yaml`, assembles systemPrompt, calls Claude Agent SDK `query()`
- [x] ~~Cron scheduler~~ — shipped (#131), see ADR-026. Future: webhooks/event-driven triggers
- [ ] Event-driven triggers (webhooks) — second automation type, under future "Automations" tab
- [ ] `state/` folder protocol — agents read/write shared state across sessions

## Later

- [ ] Platform adapters — Slack gateway adapter (stub exists, needs SDK integration)
- [ ] `--permission-mode auto` — safer alternative to `--dangerously-skip-permissions`
- [ ] Memory state viewer
- [ ] Configure agents from the dashboard
- [ ] Cross-workspace project tracking (project spans multiple repos)
- [ ] Session checkpointing — git-like branching for conversation history
- [ ] VLA runtime — `VLARuntime` implementing `AgentRuntime` for physical agents (ADR-023, punted)
