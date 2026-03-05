# OpenClaw

**Type:** Integration target — primary agent runtime substrate
**Repo:** [openclaw/openclaw](https://github.com/openclaw/openclaw) (TypeScript, MIT License)
**Docs:** [docs.openclaw.ai](https://docs.openclaw.ai)
**Version studied:** `2026.3.3` (commit `bd25182`, local checkout)
**Researched:** 2026-03-04

## What It Is

OpenClaw is a **multi-channel AI agent orchestration platform**. It runs a WebSocket gateway that routes messages from 22+ messaging channels (Telegram, Discord, Slack, WhatsApp, Signal, iMessage, LINE, MS Teams, etc.) to AI agents, handles tool execution, manages sessions, persists memory via vector search, and runs scheduled tasks via cron. Think of it as "infrastructure for always-on AI assistants."

The codebase is large and mature: ~71 subsystems in `src/`, 42 plugin extensions, 40+ bundled skills, native macOS/iOS/Android apps, and a web-based Control UI. MIT licensed (Peter Steinberger, 2025).

## Why We Care

This is our starting substrate (per ADR-003). autonomOS sits above OpenClaw as a control plane. We need to understand:

| Need | OpenClaw Provides | Gap |
|------|------------------|-----|
| Agent observability | Session list, usage, streaming events via gateway WS | No aggregate analytics |
| Agent control | Chat send/abort, session reset, agent CRUD via gateway RPC | No multi-agent orchestration |
| Scheduling | Full cron CRUD with run logging | No task/workflow concept |
| Memory | Vector DB with hybrid search, per-agent scoping | Memory search not exposed via RPC |
| Configuration | Full config read/write/schema via gateway | No version history |
| Extensibility | Plugin SDK with 25 lifecycle hooks | Clean extension point |
| Channel status | Health monitoring for 22+ channels | Observe only |
| Cost tracking | Per-session token usage | No historical aggregation |
| Device management | Node registry + pairing | Maps to robot path |
| License | MIT — fully commercial-friendly | No concerns |

## Investigation Checklist

- [x] Architecture overview — monorepo layout, gateway, agent runtime, channel system
- [x] Session model — session lifecycle, persistence, scoping, transcripts
- [x] Memory layer — vector DB (sqlite-vec), hybrid search, embedding providers
- [x] Cron/scheduling — job model, execution pipeline, run logging
- [x] Gateway architecture — WebSocket control plane, RPC methods, HTTP server
- [x] Plugin SDK — OpenClawPluginApi, tool registration, 25 hooks, config schema
- [x] CLI surface — 28+ commands, Commander.js framework
- [x] API/integration points — 50+ gateway RPC methods, WebSocket events
- [x] Event system / hooks — system events, internal hooks, bundled hooks
- [x] Observability surface — what autonomOS can read without modification
- [x] Control surface — what autonomOS can control via existing APIs
- [x] Extension strategy — plugin vs sidecar vs fork assessment
- [x] Data model mapping — OpenClaw concepts to autonomOS abstractions
- [x] Multi-agent orchestration — current state and gaps
- [x] Licensing — MIT, no commercial concerns

## Deep Dives

- **[architecture.md](architecture.md)** — Core architecture, runtime model, monorepo layout, component breakdown, data flow diagrams
- **[sessions-and-memory.md](sessions-and-memory.md)** — Session lifecycle, memory vector DB, cron scheduling system
- **[plugin-sdk.md](plugin-sdk.md)** — Plugin API, tool registration, 25 lifecycle hooks, config schema, security model
- **[integration-points.md](integration-points.md)** — All APIs, CLI commands, events, and hooks. "What we can build today" vs "what needs extension work"
- **[autonomos-integration.md](autonomos-integration.md)** — Data model mapping, observability surface, control surface, extension strategy, concrete integration plan. **Start here for the actionable analysis.**
- **[licensing.md](licensing.md)** — MIT license analysis, commercial implications

## Key Numbers

| Metric | Value |
|--------|-------|
| Source subsystems | ~71 (in `src/`) |
| Plugin extensions | 42 |
| Bundled skills | 40+ |
| Gateway RPC methods | 50+ |
| Plugin lifecycle hooks | 25 |
| Supported channels | 22+ |
| CLI commands | 28+ top-level |
| Native apps | macOS, iOS, Android |
| Test coverage target | 70% (lines/branches/functions) |
| License | MIT |

## Assessment for autonomOS

**Relevance: CRITICAL** — This is the substrate we build on.

**Key insight:** OpenClaw is an excellent **agent runtime** but not a **control plane**. It handles sessions, memory, scheduling, tool execution, and multi-channel routing. But it has no dashboard, no aggregate analytics, no multi-agent orchestration, no task management. That's exactly the gap autonomOS fills.

**Integration path:** WebSocket client for observability + control, optional plugin for deep integration (memory search, metrics, custom events), autonomOS's own DB for everything OpenClaw doesn't track. No forking needed.

**Comparison with Mission Control:** [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control) already built a dashboard for OpenClaw (see `docs/research/mission-control/`). Their patterns (SSE event bus, thin routes, Claude Code scanner) are directly portable. Where they're OpenClaw-locked, we add a provider adapter pattern for agent-agnostic support.
