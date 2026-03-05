# OpenClaw — Architecture Deep Dive

> Source: [openclaw/openclaw](https://github.com/openclaw/openclaw) (TypeScript, MIT License)
> Version studied: `2026.3.3` (commit `bd25182`, local checkout at `~/workspace/openclaw/`)

## What It Is

OpenClaw is a **multi-channel AI agent orchestration platform**. It runs a WebSocket gateway that routes messages from 22+ messaging channels (Telegram, Discord, Slack, WhatsApp, Signal, iMessage, etc.) to AI agents, handles tool execution, manages sessions, persists memory, and runs scheduled tasks. Think of it as "infrastructure for always-on AI assistants."

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        MESSAGING CHANNELS (22+)                             │
│  Telegram  Discord  Slack  WhatsApp  Signal  iMessage  LINE  MS Teams ...  │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │ Inbound messages
                    ┌──────────▼───────────┐
                    │   Gateway (WebSocket) │ ← ws://127.0.0.1:18789
                    │   Control Plane       │
                    ├──────────────────────-┤
                    │ ┌──────────────────┐  │
                    │ │ Channel Router   │  │  Route messages to agents
                    │ ├──────────────────┤  │
                    │ │ Session Manager  │  │  Per-sender session state
                    │ ├──────────────────┤  │
                    │ │ Agent Runner     │  │  Embedded Pi agent execution
                    │ ├──────────────────┤  │
                    │ │ Tool Executor    │  │  Browser, canvas, system.run, etc.
                    │ ├──────────────────┤  │
                    │ │ Cron Scheduler   │  │  Recurring agent tasks
                    │ ├──────────────────┤  │
                    │ │ Plugin Loader    │  │  42 extensions, dynamic tools
                    │ ├──────────────────┤  │
                    │ │ Memory Manager   │  │  Vector DB + hybrid search
                    │ ├──────────────────┤  │
                    │ │ HTTP Server      │  │  REST API, Control UI, webhooks
                    │ └──────────────────┘  │
                    └──────────┬───────────-┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
    ┌─────▼────┐        ┌─────▼────┐         ┌─────▼────────┐
    │ Session  │        │ Memory   │         │ Cron Store   │
    │  Store   │        │  DB      │         │  + Run Logs  │
    │(JSON KV) │        │(SQLite)  │         │(JSON + JSONL)│
    │~/.openclaw│        │ sqlite-vec│        │~/.openclaw/  │
    │/sessions │        │ embeddings│        │ cron.json    │
    └──────────┘        └──────────┘        └──────────────┘
```

## Monorepo Layout

OpenClaw uses **pnpm workspaces** with calendar versioning (`YYYY.M.D`).

```
openclaw/                        # Root workspace (package: "openclaw")
├── src/                         # Core TypeScript source (~71 subsystems)
│   ├── cli/                     # CLI wiring (Commander.js)
│   ├── commands/                # Command implementations (271 files)
│   ├── gateway/                 # WebSocket control plane (219 files)
│   ├── agents/                  # Agent runtime & routing (493 files)
│   ├── memory/                  # Vector DB + embeddings (92 files)
│   ├── cron/                    # Job scheduling (69 files)
│   ├── sessions/                # Session key management (12 files)
│   ├── config/                  # Configuration loading
│   ├── plugins/                 # Plugin loader & registry
│   ├── plugin-sdk/              # Plugin SDK (90+ exports)
│   ├── hooks/                   # Internal hook system
│   ├── routing/                 # Multi-agent routing
│   ├── media/                   # Image/audio/video pipeline (41 files)
│   ├── providers/               # LLM provider integrations
│   ├── security/                # Security mechanisms
│   ├── daemon/                  # System daemon (launchd/systemd/schtasks)
│   ├── infra/                   # Low-level infrastructure
│   ├── terminal/                # Terminal UI (tables, palette)
│   ├── browser/                 # Browser automation
│   ├── canvas-host/             # A2UI canvas rendering
│   ├── telegram/                # Telegram channel (grammY)
│   ├── discord/                 # Discord channel (discord.js)
│   ├── slack/                   # Slack channel (Bolt)
│   ├── signal/                  # Signal channel (signal-cli)
│   ├── imessage/                # iMessage channel
│   ├── web/                     # WhatsApp Web (Baileys)
│   ├── line/                    # LINE channel
│   └── ...                      # 40+ more subsystems
│
├── extensions/                  # 42 plugin extensions
│   ├── discord/                 # Discord channel plugin
│   ├── telegram/                # Telegram channel plugin
│   ├── slack/                   # Slack channel plugin
│   ├── msteams/                 # Microsoft Teams
│   ├── matrix/                  # Matrix
│   ├── memory-core/             # Memory system core
│   ├── memory-lancedb/          # Vector DB (LanceDB)
│   ├── lobster/                 # CLI UI tool
│   ├── voice-call/              # Voice calling
│   ├── phone-control/           # Mobile device control
│   ├── diagnostics-otel/        # OpenTelemetry
│   └── ...                      # 30+ more
│
├── apps/                        # Native applications
│   ├── macos/                   # macOS menu bar app (Swift/SwiftUI)
│   ├── ios/                     # iOS app (Swift/SwiftUI)
│   ├── android/                 # Android app (Kotlin/Compose)
│   └── shared/                  # OpenClawKit (shared Swift)
│
├── skills/                      # 40+ bundled skills
│   ├── discord/                 # Discord skill
│   ├── obsidian/                # Obsidian skill
│   ├── github-issues/           # GitHub Issues skill
│   └── ...
│
├── ui/                          # Web UI (Control Panel + WebChat)
├── docs/                        # Mintlify documentation
├── scripts/                     # Build/test/release scripts (112 files)
├── vendor/                      # Vendored dependencies
└── test/                        # E2E and integration tests
```

## Core Components

### 1. Gateway (The Heart)

The gateway is the central WebSocket server that everything connects to. It:
- Accepts WebSocket connections from clients (CLI, mobile apps, Control UI)
- Routes inbound messages from channels to the appropriate agent
- Manages the agent execution lifecycle
- Serves HTTP for webhooks, Control UI, and plugin routes
- Broadcasts events to connected clients (streaming text, tool calls, status changes)

**Key file:** `src/gateway/server.impl.ts` (~1000+ LOC)

**Runtime state:**
- Active WebSocket clients
- Chat run registry (tracks ongoing agent runs, buffers streamed text)
- Agent run sequencing (deduplication)
- Plugin request handler
- Canvas host handler

### 2. Agent Runtime (Pi Embedded Runner)

OpenClaw embeds the "Pi" agent runtime (`@mariozechner/pi-agent`). The execution pipeline:

```
runEmbeddedPiAgent(params)
  1. Resolve workspace, model, provider
  2. Load/validate auth profiles
  3. Resolve context window & system prompt
  4. Retry loop:
     - Attempt agent turn (with tool calls)
     - Handle errors (auth, rate limit, overflow)
     - Fallback to alternate model on failure
  5. Accumulate usage stats
  6. Compact on overflow
  7. Return result (text, usage, error)
```

**Key features:**
- Model selection with multi-provider fallover
- Auth profile rotation (OAuth cooldown + API key rotation)
- Context window management with overflow compaction
- Streaming tool calls

### 3. Channel System

Each channel is a plugin that:
1. Connects to a messaging platform
2. Normalizes inbound messages
3. Injects them into the gateway
4. Delivers agent responses back to the platform

**Core channels** (in `src/`): Telegram, Discord, Slack, Signal, iMessage, LINE, WhatsApp Web
**Extension channels** (in `extensions/`): MS Teams, Matrix, Feishu, Google Chat, IRC, Mattermost, Nostr, Twitch, and more

### 4. Plugin System

Plugins are the primary extensibility mechanism. They can register:
- **Tools** — agent-callable functions with TypeBox schemas
- **Hooks** — lifecycle event handlers (25 event types)
- **Channels** — new messaging platform integrations
- **HTTP routes** — custom API endpoints
- **CLI commands** — new CLI subcommands
- **Services** — long-running background services
- **Providers** — new LLM providers

### 5. Memory System

Vector database using **sqlite-vec** with hybrid search:
- Embedding providers: OpenAI, Mistral, Voyage, Gemini, Ollama
- BM25 keyword search + vector similarity, merged with weighted scoring
- File watching via chokidar for workspace changes
- Session transcript syncing to vector DB
- Per-agent/workspace isolation

### 6. Cron Scheduler

Scheduled job execution:
- Schedule types: one-shot (`at`), interval (`every`), cron expression
- Each run spawns an isolated agent session
- Result delivery to channels or webhook POST
- Run logging to JSONL files with auto-pruning
- Failure tracking with backoff and alerts

## Data Flow: Message to Response

```
1. User sends "What's the weather?" in Telegram
                        │
                        ▼
2. Telegram plugin (grammY) normalizes message
   → { sender, text, chatType, metadata }
                        │
                        ▼
3. Gateway receives via channel injection
   → Loads/creates SessionEntry
   → Resolves routing (which agent?)
                        │
                        ▼
4. runEmbeddedPiAgent() spawns agent turn
   → Loads transcript from disk
   → Builds system prompt (workspace + skills + tools)
   → Calls LLM API (Claude, GPT, Gemini, etc.)
                        │
                        ▼
5. Agent executes (may call tools)
   → Streams partial text to gateway
   → Gateway broadcasts to connected clients
                        │
                        ▼
6. Final response delivered
   → Gateway sends back to Telegram
   → Updates session with usage stats
   → Persists SessionEntry
```

## Configuration

All config lives at `~/.openclaw/`:

| File | Purpose |
|------|---------|
| `openclaw.json` | Main config (gateway, channels, agents, plugins, tools) |
| `sessions.json` | Session state store |
| `cron.json` | Cron job definitions |
| `models.json` | Model catalog + provider configs |
| `credentials/` | API keys, OAuth tokens |
| `hooks/` | Custom internal hooks |
| `extensions/` | User-installed plugins |
| `workspace/` | Default agent workspace |
| `sessions/` | Session transcript files |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 22+ (TypeScript, ESM) |
| CLI | Commander.js |
| Gateway | WebSocket (`ws` library) |
| HTTP | Express-like server |
| Agent | Pi embedded runner |
| Memory | sqlite-vec (vector), FTS5 (keyword) |
| Scheduling | Croner (cron parsing) |
| Validation | TypeBox (tools), Zod (config) |
| Build | tsdown (SWC-based) |
| Test | Vitest (70% coverage threshold) |
| Lint | Oxlint + Oxfmt |
| Package Manager | pnpm (Bun also supported) |

## Takeaway for autonomOS

OpenClaw is a **production-grade agent infrastructure** with three key properties that matter for us:

1. **It's the substrate, not the brain** — OpenClaw handles orchestration (routing, sessions, scheduling, tool execution) but doesn't own the AI model. This aligns perfectly with autonomOS sitting above it as a control plane.

2. **Everything flows through the gateway** — The WebSocket gateway is the single point of observation. Any data autonomOS needs (sessions, logs, token usage, cron status, agent state) flows through gateway RPC methods.

3. **Plugin-extensible** — If the existing APIs aren't enough, OpenClaw's plugin SDK lets us register custom tools, hooks, HTTP routes, and CLI commands without forking. An `autonomos` OpenClaw plugin could expose exactly the data we need.
