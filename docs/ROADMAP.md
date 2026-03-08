# Roadmap

Last updated: 2026-03-08

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

## Now — Core Loop

The demo: open autonomOS, spawn a Claude Code session, use it in the browser.

- [ ] Verify the core loop works end-to-end (spawn → interact → reconnect)
- [ ] Fix any rough edges blocking daily use
- [ ] Multi-terminal support (P1 — view multiple sessions at once)

## Next — Make It Useful

- [ ] Session naming / labeling
- [ ] OpenClaw integration — read agent status, cron jobs
- [ ] Token spend / cost tracking per session
- [ ] Mobile-responsive layout

## Later

- [ ] Agent activity dashboard (what's running, what failed)
- [ ] Memory state viewer
- [ ] Configure agents from the dashboard
- [ ] Robot path (aspirational)
