# YepAnywhere Architecture

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Hono (Node.js HTTP framework) |
| Client | React + Vite |
| Types | TypeScript, Zod (schema validation) |
| Real-time | WebSocket (Hono node-ws), SSE |
| Build | pnpm workspaces, tsx, tsc |
| Lint | Biome |
| AI SDK | `@anthropic-ai/claude-agent-sdk` |
| Crypto | tweetnacl (NaCl), tssrp6a (SRP) |
| Push | web-push (VAPID) |

## Package Structure

```
packages/
  server/       # Hono server — session management, SDK integration, API
  client/       # React web app — session viewer, dashboard, mobile UI
  shared/       # Shared types, Zod schemas, crypto types
  relay/        # Relay server for remote access (SRP + NaCl E2E encryption, SQLite)
  desktop/      # Tauri 2.x desktop app (Rust + React + xterm.js terminal)
  mobile/       # Tauri 2.x mobile app (iOS/Android)
  device-bridge/# Android/ChromeOS device streaming (WebRTC)
  android-device-server/ # Android sidecar for device bridge
```

### Server Package (~core)

```
packages/server/src/
  index.ts              # Entry point (~999 lines) — server bootstrap, wiring
  app.ts                # Hono app factory — route registration, middleware
  config.ts             # Configuration (ports, data dir, profiles)

  sdk/                  # Claude SDK integration
    providers/          # AgentProvider implementations
      types.ts          # AgentProvider interface, AgentSession, StartSessionOptions
      claude.ts         # ClaudeProvider — wraps @anthropic-ai/claude-agent-sdk query()
      claude-ollama.ts  # Local Ollama models via Claude SDK
      codex.ts          # OpenAI Codex provider
      codex-oss.ts      # Codex OSS (local models)
      gemini.ts         # Google Gemini CLI
      gemini-acp.ts     # Gemini via ACP protocol
      opencode.ts       # OpenCode HTTP server
    messageQueue.ts     # Async generator queue for SDK prompt streaming
    session-sync.ts     # Remote session file syncing (rsync over SSH)
    remote-spawn.ts     # SSH-based remote process spawning

  supervisor/           # Process lifecycle management
    Supervisor.ts       # Session start/resume/abort, worker queue, capacity management
    Process.ts          # Single agent process — message routing, state machine, SSE replay
    ExternalSessionTracker.ts  # Detects sessions controlled by external programs (terminal)
    WorkerQueue.ts      # Request queuing when at capacity
    types.ts            # ProcessState, SessionOwnership, ProcessInfo

  watcher/              # File system monitoring
    FileWatcher.ts      # fs.watch on ~/.claude/projects/, ~/.gemini/tmp, ~/.codex/sessions
    EventBus.ts         # In-memory pub/sub (15 event types)
    FocusedSessionWatchManager.ts  # Optimized watching for active sessions
    BatchProcessor.ts   # Batched JSONL parsing to prevent OOM
    SourceWatcher.ts    # Dev: watches server source for reload

  sessions/             # Session data reading
    Session.ts          # ServerSession extends SessionView with I/O
    reader.ts           # Claude JSONL reader
    codex-reader.ts     # Codex session reader
    gemini-reader.ts    # Gemini session reader
    opencode-reader.ts  # OpenCode session reader
    normalization.ts    # Normalize across providers to unified format
    pagination.ts       # Session message pagination

  projects/             # Project discovery
    scanner.ts          # ProjectScanner — scans ~/.claude/projects/ for projects
    codex-scanner.ts    # Codex project scanner
    gemini-scanner.ts   # Gemini project scanner
    paths.ts            # Path encoding/decoding (base64url project IDs)

  routes/               # API endpoints (25+ modules)
    sessions.ts         # CRUD for sessions, start/resume/abort, message sending
    projects.ts         # Project listing, session listing per project
    activity.ts         # SSE/WebSocket activity stream
    processes.ts        # Active process management
    health.ts           # Health check
    settings.ts         # Server settings CRUD
    providers.ts        # Provider listing and auth status
    inbox.ts            # Notification inbox
    files.ts            # File content serving (syntax highlighted)
    git-status.ts       # Git status for projects
    upload.ts           # File upload handling
    ws-relay.ts         # WebSocket relay handlers
    ws-message-router.ts # WebSocket message routing
    ...and more

  augments/             # Server-side content augmentation
    stream-augmenter.ts # Real-time markdown rendering, edit diff computation
    edit-augments.ts    # Compute unified diffs for Edit tool calls
    markdown-augments.ts # Syntax highlighting via shiki

  auth/                 # Authentication
    AuthService.ts      # Password hashing, session tokens, cookie auth

  notifications/        # Notification tracking
  push/                 # Web Push (VAPID) for mobile notifications
  metadata/             # Session/project metadata persistence
  indexes/              # Session index cache (optimized lookups)
```

## Core Abstractions

### AgentProvider Interface

```typescript
interface AgentProvider {
  name: ProviderName;
  displayName: string;
  supportsPermissionMode: boolean;
  supportsThinkingToggle: boolean;
  supportsSlashCommands: boolean;

  isInstalled(): Promise<boolean>;
  isAuthenticated(): Promise<boolean>;
  getAuthStatus(): Promise<AuthStatus>;
  startSession(options: StartSessionOptions): Promise<AgentSession>;
  getAvailableModels(): Promise<ModelInfo[]>;
}
```

All 7 providers implement this. `AgentSession` returns an async iterator of `SDKMessage`, a `MessageQueue` for input, and `abort()`.

### Supervisor + Process Model

```
Supervisor (1 per server)
  ├── Process (1 per active session)
  │   ├── AgentSession (from provider.startSession())
  │   ├── MessageQueue (for queuing user input)
  │   ├── Event listeners (for SSE/WS subscribers)
  │   └── State machine: in-turn → waiting-input → idle → terminated
  └── WorkerQueue (for capacity management)
```

The Supervisor manages process lifecycle: start, resume, abort, idle timeout, stale detection (5min no SDK messages), worker capacity limits, and preemption of idle workers.

### Session Ownership Model

```typescript
type SessionOwnership =
  | { owner: "none" }                    // No active process
  | { owner: "self"; processId: string } // This server controls it
  | { owner: "external" }               // Terminal or other program controls it
```

This is critical: YepAnywhere distinguishes between sessions IT owns (full control) and sessions controlled externally (read-only observation).

### EventBus

Simple in-memory pub/sub with 15 event types:
- `file-change` — FileWatcher detected a session file change
- `session-status-changed` — Ownership changed
- `session-created` — New session detected
- `session-updated` — Title, messageCount, contextUsage changed
- `session-aborted` — Process killed
- `process-state-changed` — Agent activity (in-turn, waiting-input)
- `worker-activity-changed` — Worker pool status
- `queue-*` — Worker queue events
- `session-metadata-changed` — User-set title, archive, star
- `source-change` — Dev reload
- `browser-tab-*` — Client connection tracking

## Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Claude Code    │     │  YepAnywhere     │     │  Web Client     │
│  (terminal)     │     │  Server          │     │  (React)        │
└────────┬────────┘     └────────┬─────────┘     └────────┬────────┘
         │                       │                         │
         │ writes JSONL          │                         │
         ├──────────────────────>│ FileWatcher detects     │
         │                       │ ExternalSessionTracker  │
         │                       │ emits events            │
         │                       ├────────────────────────>│ WebSocket/SSE
         │                       │                         │ updates UI
         │                       │                         │
         │                       │ SDK query()             │
         │                       │<────────────────────────┤ User sends message
         │                       │ spawns Claude CLI       │
         │                       │ process                 │
         │                       │                         │
         │                       │ SDK message iterator    │
         │                       ├────────────────────────>│ Real-time streaming
         │                       │                         │
         │                       │ canUseTool callback     │
         │                       ├────────────────────────>│ Tool approval request
         │                       │<────────────────────────┤ User approves/denies
         │                       │                         │
```

## Port Architecture

All ports derived from single `PORT` env var (default 3400):
- `PORT + 0` — Main Hono server
- `PORT + 1` — Maintenance server (diagnostics, log levels, inspector)
- `PORT + 2` — Vite dev server (HMR only)

## Data Storage

State stored in `~/.yep-anywhere/` (or `~/.yep-anywhere-{profile}/`):
- `session-metadata.json` — Custom titles, archive/star status
- `project-metadata.json` — Manually added projects
- `auth.json` — Password hash, session tokens
- `vapid.json` — VAPID keys for push notifications
- `push-subscriptions.json` — Web push subscriptions
- `notifications.json` — Last-seen timestamps
- `indexes/` — Session index cache
- `uploads/` — Uploaded files
- `logs/` — Server and client logs
