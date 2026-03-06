# YepAnywhere

**Type:** Integration target — session bridge and mobile supervisor UI
**Repo:** Local checkout at `~/workspace/yepanywhere/` (published to npm as `yepanywhere`)
**Version studied:** `0.4.8` (commit `cced066`, 2026-03-03)
**Researched:** 2026-03-05

## What It Is

YepAnywhere is a **mobile-first supervisor for Claude Code agents** (and Codex, Gemini, OpenCode). It runs a Hono server on your dev machine that manages Claude Code SDK processes, streams session data to a React web client via WebSocket, and enables mobile supervision with push notifications for tool approvals. Think of it as "VS Code Claude extension, but for phones and multi-session workflows."

The codebase is substantial: ~159K lines of TypeScript across 8 packages. 7 AI providers supported (Claude, Claude-Ollama, Codex, Codex-OSS, Gemini, Gemini-ACP, OpenCode). Active development since Jan 2025 with 40+ releases.

## Why We Care

YepAnywhere has already solved the **session bridge problem** — observing and interacting with Claude Code sessions from a web UI while the terminal continues working. This is exactly the substrate autonomOS needs for its session observability layer.

| Need | YepAnywhere Provides | Gap |
|------|---------------------|-----|
| Session discovery | FileWatcher on `~/.claude/projects/`, Codex, Gemini dirs | No plugin API for custom scanners |
| Session observation | Real-time streaming via WebSocket + SSE | Read-only for external sessions |
| Session control | Full bidirectional: send messages, approve tools, abort | Only for server-owned sessions |
| Multi-session | Dashboard with all sessions across projects | No orchestration between sessions |
| Mobile access | Push notifications, tool approval from lock screen | Purpose-built, hard to decouple |
| Remote access | Relay server with SRP auth + NaCl encryption | Relay is a separate package |
| Multi-provider | 7 providers via AgentProvider interface | Clean abstraction |
| Cost tracking | Context usage per session | No historical aggregation |
| Task management | None | Major gap for autonomOS |
| Extensibility | No plugin/hook system | Would need fork or wrapper |
| Desktop/Mobile | Tauri 2.x (Rust-based) | Different UI priorities for autonomOS |
| License | MIT | Fully compatible |

## Investigation Checklist

- [x] Architecture overview — monorepo, packages, server/client split
- [x] Session discovery — FileWatcher, ProjectScanner, ExternalSessionTracker
- [x] Session transport — Claude Agent SDK `query()`, process spawning, MessageQueue
- [x] Multi-client model — server owns sessions, clients subscribe via WebSocket
- [x] Session lifecycle — start, resume, abort, idle timeout, stale detection
- [x] Real-time streaming — WebSocket subscriptions, SSE, stream augmentation
- [x] API surface — Hono routes, WebSocket messages, EventBus events
- [x] Multi-provider — AgentProvider interface, 7 implementations
- [x] Authentication — SRP, NaCl encryption, cookie auth
- [x] Notifications — Web Push (VAPID), push notifications for approvals
- [x] Code size and maturity — 159K LOC, 40+ releases, actively developed
- [x] Licensing — MIT (declared in README, no separate LICENSE file)

## Deep Dives

- **[architecture.md](architecture.md)** — Package structure, tech stack, data flow, key abstractions
- **[session-bridge.md](session-bridge.md)** — Session discovery, transport, multi-client model, co-existence. **Start here.**
- **[autonomos-integration.md](autonomos-integration.md)** — What to adopt, adapt, or build fresh. Integration strategy.
- **[licensing.md](licensing.md)** — License analysis and commercial viability

## Key Numbers

| Metric | Value |
|--------|-------|
| Total LOC (TS/TSX) | ~159K (server: 51.5K, client: 54K, shared: 7K, relay: 1.3K) |
| Packages | 8 (server, client, shared, relay, desktop, mobile, device-bridge, android-device-server) |
| AI Providers | 7 (Claude, Claude-Ollama, Codex, Codex-OSS, Gemini, Gemini-ACP, OpenCode) |
| Server routes | 25+ route modules |
| EventBus events | 15 event types |
| npm releases | 40+ (since Jan 2025) |
| License | MIT (declared in README) |

## Assessment for autonomOS

**Relevance: HIGH** — YepAnywhere has solved the hardest part of our session bridge: bidirectional Claude Code session management via the SDK. Their architecture is a validated reference implementation.

**Key insight:** YepAnywhere is a **standalone supervisor app**, not a library (all packages marked `private`). But it's MIT licensed, so we can freely study, adapt, or extract code. The architectural patterns — `AgentProvider` interface, `Supervisor` + `Process` model, `FileWatcher` + `ExternalSessionTracker` for discovery, WebSocket streaming, and `MessageQueue` async generator bridge — are all directly adoptable.

**One proprietary dependency:** `@anthropic-ai/claude-agent-sdk` is Anthropic-proprietary (not MIT). We'd need this regardless, but it means Claude Code integration is subject to Anthropic's terms.

**Comparison with Mission Control:** Mission Control (builderz-labs) scans JSONL files read-only. YepAnywhere goes much further with bidirectional SDK integration, multi-provider support, and mobile-first design. For autonomOS, YepAnywhere's architecture is the better reference.
