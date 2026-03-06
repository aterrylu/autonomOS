# YepAnywhere Integration Strategy for autonomOS

## What to Adopt

YepAnywhere is MIT licensed, so we can freely copy code, adapt patterns, or use it as reference. The `@anthropic-ai/claude-agent-sdk` dependency is Anthropic-proprietary but required regardless.

### 1. Session Discovery Pattern (HIGH PRIORITY)

**YepAnywhere's approach:**
- `FileWatcher` monitors `~/.claude/projects/` with `fs.watch({ recursive: true })`
- Debounced events, mtime-based change detection, periodic rescan fallback
- `ExternalSessionTracker` distinguishes server-owned vs external sessions

**What we should build:**
- Same file watching approach (this is a standard pattern, not protectable)
- Our `SessionScanner` should support provider-specific directory conventions:
  - Claude: `~/.claude/projects/{hash}/{session}.jsonl`
  - Codex: `~/.codex/sessions/{year}/{month}/{day}/rollout-*.jsonl`
  - Gemini: `~/.gemini/tmp/{hash}/chats/session-*.json`
- EventBus pattern for decoupled notification

### 2. AgentProvider Abstraction (HIGH PRIORITY)

**YepAnywhere's `AgentProvider` interface is clean and extensible:**
```typescript
interface AgentProvider {
  name: ProviderName;
  isInstalled(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
  startSession(options): Promise<AgentSession>;
  getAvailableModels(): Promise<ModelInfo[]>;
}
```

**For autonomOS:**
- We need a similar abstraction but broader — not just Claude Code, but also OpenClaw agents
- Our provider interface should support:
  - Session discovery (list existing sessions)
  - Session observation (read-only streaming)
  - Session control (bidirectional messaging)
  - Session creation (start new)
- YepAnywhere's `AgentSession` return type (iterator + queue + abort) is a good model

### 3. Supervisor + Process Model (MEDIUM PRIORITY)

**What YepAnywhere does well:**
- Clean process lifecycle management (state machine: in-turn → waiting-input → idle → terminated)
- Stale detection (5min no messages + process liveness check)
- Worker capacity management with queue and preemption
- Two-bucket message buffer for late-joining clients (bounded memory)

**For autonomOS:**
- We'll need a similar process manager, but with:
  - Multi-agent orchestration (YepAnywhere manages sessions independently)
  - Task-to-session mapping (YepAnywhere has no task concept)
  - Session grouping by workflow/plan

### 4. Real-Time Streaming (MEDIUM PRIORITY)

**YepAnywhere pattern:**
- Process emits events → subscription handler → emit to WebSocket/SSE
- Late-joining client catch-up via replay buffer + streaming text accumulation
- Server-side markdown rendering and diff computation

**For autonomOS:**
- Same pattern works, but we should use a proper event streaming library
- Consider SSE over WebSocket for simplicity (one-way streaming, reconnect built-in)
- Server-side augmentation is valuable for mobile — keep this pattern

### 5. MessageQueue Async Generator (HIGH PRIORITY)

**The bridge between HTTP and SDK streaming:**
```
HTTP POST /message → queue.push(msg) → async generator yields → SDK consumes
```

This is the key innovation that makes bidirectional control work. The Claude Agent SDK expects an async generator for prompts, and MessageQueue bridges the gap.

## What NOT to Adopt

### 1. Standalone Server Architecture
YepAnywhere is a monolithic server + client. autonomOS needs a modular architecture where the session bridge is one component among many (OpenClaw gateway, task manager, analytics, etc.).

### 2. File-Based State
YepAnywhere stores metadata in JSON files (`session-metadata.json`, `auth.json`). autonomOS should use a proper database for:
- Historical cost tracking
- Task-to-session mapping
- Cross-session analytics
- Multi-user access

### 3. SRP + NaCl Remote Access
The relay + SRP + NaCl stack is specific to YepAnywhere's "no external dependencies" philosophy. For autonomOS, standard auth (OAuth, JWT) and TLS is simpler and more appropriate.

### 4. Mobile-First UI
YepAnywhere's React client is purpose-built for phone supervision. autonomOS needs a desktop-first dashboard with different UX priorities (analytics, orchestration, configuration).

## Gaps autonomOS Must Fill

| Capability | YepAnywhere | autonomOS Need |
|-----------|-------------|----------------|
| Task management | None | Plans, backlogs, workflows |
| Multi-agent orchestration | Independent sessions | Coordinated agent teams |
| Historical analytics | Per-session context usage | Cost trends, token budgets, efficiency metrics |
| Configuration management | Server settings JSON | Agent config versioning, templates, inheritance |
| Multi-user | Single user | Team access, permissions |
| Plugin system | None | Plugin SDK for extensions |
| OpenClaw integration | None | Primary agent runtime |
| Hardware/robot control | Device bridge (Android) | Robot path management |

## Integration Architecture

```
autonomOS Control Plane
├── Session Bridge Layer (inspired by YepAnywhere patterns)
│   ├── FileWatcher → EventBus (session discovery)
│   ├── ExternalSessionTracker (terminal co-existence)
│   ├── AgentProvider interface (multi-provider)
│   ├── ProcessManager (lifecycle, state machine)
│   └── MessageQueue (bidirectional SDK bridge)
│
├── OpenClaw Gateway Client (from openclaw research)
│   ├── WebSocket RPC (50+ methods)
│   ├── Session streaming
│   └── Plugin API
│
├── Task Manager (new for autonomOS)
│   ├── Plan → Session mapping
│   ├── Workflow orchestration
│   └── Cost budgeting
│
└── Dashboard (new for autonomOS)
    ├── Multi-agent overview
    ├── Analytics
    └── Configuration
```

## Concrete Next Steps

1. **Build session discovery** — Implement FileWatcher + ProjectScanner (can adapt from YepAnywhere under MIT). This is the foundation everything else depends on. Uses Claude Code's standard directory conventions.

2. **Implement AgentProvider for Claude Code** — Use `@anthropic-ai/claude-agent-sdk` directly. YepAnywhere's ClaudeProvider is essentially a thin wrapper around `query()` — can adapt directly.

3. **Build ProcessManager** — State machine for session lifecycle. The in-turn/waiting-input/idle/terminated model is straightforward.

4. **Integrate with OpenClaw** — The OpenClaw gateway provides similar session management for OpenClaw agents. Build an adapter that implements our AgentProvider interface.

5. **Build the dashboard** — This is where autonomOS diverges significantly from YepAnywhere. Focus on multi-agent orchestration, task management, and analytics rather than mobile supervision.

6. **Consider inbox pattern** — YepAnywhere has a tiered inbox (needsAttention → active → recentActivity → unread8h → unread24h) that's a good UX pattern for multi-session supervision.

## SDK Dependencies

The key dependency for Claude Code integration is:

```json
"@anthropic-ai/claude-agent-sdk": "^0.2.19"
```

This is the official SDK (proprietary, Anthropic terms). Key functions:
- `query()` — Start a Claude Code session with streaming
- `query.supportedModels()` — List available models
- `query.supportedCommands()` — List available slash commands
- `query.setMaxThinkingTokens()` — Change thinking config
- `query.interrupt()` — Graceful turn interruption
- `query.setModel()` — Change model mid-session

The SDK handles:
- Claude Code CLI discovery and spawning
- Session persistence (JSONL files)
- Tool use protocol
- OAuth/API key authentication
- Partial message streaming

We can use this SDK directly without any YepAnywhere code.
