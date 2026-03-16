# Roadmap

Last updated: 2026-03-15

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
- [x] Auto-expand active project in sidebar
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
- [x] Settings panel — configure API keys and provider settings from dashboard
- [x] Markdown preview — Ctrl+click .md links in terminal, mermaid diagram support (ADR-018)
- [x] Codicon icons — VSCode-style iconography throughout UI
- [x] Drag-to-reorder — reorder sessions and preview panes in sidebar
- [x] Simplified Makefile — dev/prod split, PM2 daemon, removed Tailscale sidecar (ADR-017)
- [x] Remote deployment — `make deploy` with rsync + PM2

## Now — Orchestrator Foundation

Evolve from passive dashboard to orchestrator-first platform (ADR-012).

- [x] Session naming — `basename · shortId` default, `customTitle > summary` for project sessions
  - Note: SDK `listSessions()` has a bug where `customTitle` returns `undefined` (v0.2.71). We pass it through so it works when fixed. Rename via `/rename` in terminal for now.
- [ ] Conversation view — structured chat UI alternative to raw terminal (F-003)
- [ ] Rename "Projects" → "Workspaces" in UI (repos are workspaces, not projects)
- [ ] Project model — logical goals with status, roadmap, linked workspaces
- [ ] Orchestrator chat — main page becomes a conversation with the PM agent
- [ ] Fix rough edges blocking daily use

## Next — Make It Useful

- [ ] Multi-terminal — view multiple sessions side by side (split panes)
- [ ] Token spend / cost tracking per session (extend claude-usage plugin)
- [ ] Agent activity dashboard (what's running, what failed)
- [ ] Session rename from dashboard (blocked by SDK `customTitle` bug, or needs own metadata file)
- [ ] OpenClaw integration — read agent status, cron jobs

## Later

- [ ] Memory state viewer
- [ ] Configure agents from the dashboard
- [ ] Cross-workspace project tracking (project spans multiple repos)
- [ ] Move shared types (ProjectInfo, ProjectSession) to @autonomos/core
- [ ] Robot path (aspirational)
