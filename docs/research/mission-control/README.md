# builderz-labs/mission-control

**Type:** Competition / reference / template to study
**Repo:** https://github.com/builderz-labs/mission-control
**Version studied:** v1.3.0 (commit d826435, 2026-03-02)
**Researched:** 2026-03-04

## What It Is

An open-source AI agent orchestration dashboard built with Next.js 16. Single process, zero external dependencies (SQLite only), ships 64 API routes and 26 UI panels. Manages agent fleets, tasks, costs, sessions, webhooks, memory, and more.

Think of it as "Grafana for AI agents" — a read/write dashboard that sits above agent runtimes and provides observability + control.

## Why We Care

This is the closest existing project to what autonomOS wants to be. They've already solved many of the same problems:
- Observability of agent activity, token spend, and session state
- Agent lifecycle management (register, heartbeat, offline detection)
- Task orchestration (Kanban board with quality gates)
- Real-time reactivity (SSE + WebSocket dual-channel)
- Local-only mode (works without a gateway)
- Claude Code session tracking (scans `~/.claude/projects/`)

**Key difference:** MC is OpenClaw-centric. autonomOS aims to be agent-agnostic with a robot path. MC is also monolithic (single Next.js process); autonomOS plans a `packages/core` + `packages/dashboard` split.

## Investigation Status

- [x] What does it actually do? Feature set overview
- [x] Architecture and tech stack
- [x] What agents/runtimes does it support?
- [x] UI/UX — what does their dashboard look like?
- [x] SQLite schema and data model
- [x] Real-time communication patterns
- [x] Auth and security model
- [x] Background job scheduling
- [x] What's missing that autonomOS should do better?

## Quick Stats

| Metric | Value |
|--------|-------|
| Source files | ~130 TypeScript files |
| API routes | 64 REST endpoints |
| UI panels | 26 feature panels |
| DB tables | ~20 (via 20 migrations) |
| Tests | 165 E2E (Playwright) + unit (Vitest) |
| Lines (store) | ~760 lines, single Zustand file |
| Dependencies | Next.js 16, React 19, better-sqlite3, Zustand, Recharts, Zod |

## Deep Dives

- **[architecture.md](architecture.md)** — Full technical architecture breakdown
- **[data-model.md](data-model.md)** — Complete SQLite schema with all 20 tables
- **[patterns.md](patterns.md)** — What to steal vs what to rethink for autonomOS

## Assessment for autonomOS

### What They Got Right (steal these patterns)

1. **SSE event bus for local reactivity** — The `EventBus` pattern (Node.js EventEmitter singleton that bridges DB writes to SSE clients) is elegant. Every mutation auto-triggers UI updates and webhook deliveries without coupling. This should be our core reactivity pattern too.

2. **Dual-mode dashboard (local vs gateway)** — MC works standalone (no gateway) or connected to OpenClaw. This "local-first" approach is exactly what autonomOS needs — your dashboard should be useful immediately, even without any agent runtime configured.

3. **Thin routes, thick lib/** — Every API route is 30-150 lines: auth check → validate → business logic → respond. All reusable logic lives in `lib/`. Makes the backend testable and composable. Copy this pattern directly.

4. **SQLite WAL mode** — Zero-config persistence. No Postgres/Redis to set up. Perfect for personal-tool-first philosophy. WAL mode enables concurrent reads during writes.

5. **Claude Code session scanner** — They scan `~/.claude/projects/*.jsonl` every 60 seconds, parse token usage and session metadata, and upsert to the DB. This is directly useful — port it to autonomOS.

6. **Zod validation on every mutation** — One `validation.ts` file with all schemas. Clean boundary between untrusted input and business logic.

### What's Weak (rethink for autonomOS)

1. **Tightly coupled to OpenClaw** — Agent sync reads `openclaw.json`, gateway protocol is OpenClaw v3, the whole config assumes `OPENCLAW_HOME`. autonomOS needs a **provider adapter pattern** — define an interface, implement per runtime.

2. **Monolithic Zustand store** — One 760-line file. Works but painful to navigate. autonomOS should slice by feature from the start (e.g., `store/agents.ts`, `store/tasks.ts`).

3. **No persistent agent abstraction** — MC's "agents" are just DB rows with a name and status. There's no concept of an agent's capabilities, memory state, or runtime identity beyond what OpenClaw provides. autonomOS needs richer agent modeling (this is what `packages/core` is for).

4. **In-process scheduler** — Background tasks run via `setInterval` inside the Next.js process. If the process restarts, all timers reset. Fine for v1, but autonomOS should consider a more resilient approach eventually.

5. **No offline/edge support** — MC is a traditional client-server app. No service worker, no offline caching, no progressive enhancement. Fine for a server dashboard, but if autonomOS ever runs on robots or edge devices, this matters.

6. **Frontend routing is a switch statement** — 26 panels routed by a `ContentRouter` switch. No URL-based routing, no deep linking, no browser history. URL-based routing from the start would be better.

### Features MC Has That autonomOS Will Need

| Feature | MC Implementation | Priority for autonomOS |
|---------|------------------|----------------------|
| Agent registry | SQLite table, heartbeat timeout | **High** — core abstraction |
| Task board | Kanban (inbox→done), 6 columns | Medium — nice but not day-1 |
| Real-time updates | SSE event bus + WebSocket | **High** — observability requires it |
| Token/cost tracking | Per-session, per-model, Recharts | **High** — you need this immediately |
| Auth + RBAC | Session cookies, API keys, 3 roles | Low — personal tool, auth later |
| Webhooks | HMAC-signed, retry with backoff | Low — useful but not MVP |
| Quality gates | Review workflow before done | Low — task workflow feature |
| Claude session scan | JSONL parser, 60s interval | **High** — your primary use case |
| Agent chat | Messages, conversations, SSE | Medium — useful for multi-agent |
| Background scheduler | Backup, cleanup, heartbeat | Medium — nice for automation |
| Multi-gateway | Connect to multiple runtimes | **High** — agent-agnostic is your differentiator |
