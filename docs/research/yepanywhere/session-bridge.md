# YepAnywhere Session Bridge — Deep Dive

This is the most critical research file. It covers how YepAnywhere discovers, connects to, and manages Claude Code sessions — the exact problem autonomOS needs to solve.

## Session Discovery

### How Sessions Are Found

YepAnywhere uses a three-layer discovery system:

**Layer 1: FileWatcher** (`packages/server/src/watcher/FileWatcher.ts`)

Watches directories for JSONL file changes using Node's `fs.watch({ recursive: true })`:

| Provider | Watch Directory | File Pattern |
|----------|----------------|-------------|
| Claude | `~/.claude/projects/` | `{hash}/{session}.jsonl` |
| Gemini | `~/.gemini/tmp/` | `{hash}/chats/session-*.json` |
| Codex | `~/.codex/sessions/` | `{year}/{month}/{day}/rollout-*.jsonl` |

The FileWatcher:
- Builds an initial file index on startup (scan existing files + mtimes)
- Debounces events per-file (200ms default)
- Detects create vs modify vs delete by comparing against known files
- Falls back to full tree rescan when `fs.watch` provides no filename (common on macOS under load)
- Optional periodic rescan for platforms where `fs.watch` misses deep writes
- Emits `FileChangeEvent` to the `EventBus`

**Layer 2: ProjectScanner** (`packages/server/src/projects/scanner.ts`)

Scans `~/.claude/projects/` to discover projects (directories containing session files):

```
~/.claude/projects/
  -home-user-myproject/        ← Direct project (path-encoded)
    abc123.jsonl               ← Session file
    def456.jsonl
  hostname/                    ← Hostname directory (remote sessions)
    -home-user-project/
      ghi789.jsonl
```

Key behaviors:
- **Cross-machine dedup**: Sessions from different hostnames for the same project path are merged
- **CWD detection**: Reads the first line of JSONL files to extract the working directory (`cwd`)
- **Multi-provider merge**: Combines Claude, Codex, and Gemini projects into a single list
- **Project IDs**: Base64url-encoded project paths (safe for URLs)
- **Cache with invalidation**: Cached snapshots invalidated by EventBus file-change events (5s TTL)

**Layer 3: ExternalSessionTracker** (`packages/server/src/supervisor/ExternalSessionTracker.ts`)

Detects sessions being modified by external programs (e.g., terminal Claude Code):

```
FileWatcher detects JSONL write
  → ExternalSessionTracker checks: does Supervisor own this session?
    → YES: ignore (we're writing it)
    → NO: mark as "external" ownership, emit session-status-changed event
      → After 30s of no activity: decay back to "none" ownership
```

This enables the web UI to show "external" sessions in real-time — you see terminal Claude Code activity reflected in the dashboard even though YepAnywhere didn't start that session.

The tracker also:
- Parses JSONL to extract session titles and message counts for new external sessions
- Emits `session-created` events when it first detects a new external session
- Emits `session-updated` events when title/messageCount/contextUsage changes
- Uses a `BatchProcessor` to prevent OOM from concurrent JSONL parsing
- Has an abort grace period (30s) to prevent re-detecting recently killed sessions as external

## Session Transport

### How YepAnywhere Controls Sessions

**For server-owned sessions** (started from the web UI):

```typescript
// 1. Supervisor.startSession() is called from the sessions route
const process = await supervisor.startSession(projectPath, message, permissionMode, modelSettings);

// 2. Supervisor resolves a provider (e.g., ClaudeProvider)
const provider = getProvider(modelSettings.providerName ?? "claude");

// 3. Provider.startSession() is called
const agentSession = await provider.startSession({
  cwd: projectPath,
  initialMessage: message,
  resumeSessionId: sessionId,  // for resume
  permissionMode: "default",
  model: "opus",
  thinking: { type: "adaptive" },
});

// 4. ClaudeProvider uses @anthropic-ai/claude-agent-sdk query()
const sdkQuery = query({
  prompt: queue.generator(),      // async generator yielding user messages
  options: {
    cwd: effectiveCwd,
    resume: options.resumeSessionId,
    abortController,
    permissionMode,
    canUseTool,                    // tool approval callback
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,  // streaming partial results
    model: "opus",
    thinking: { type: "adaptive" },
    spawnClaudeCodeProcess,        // custom spawn (for liveness tracking or SSH)
  },
});

// 5. SDK spawns a Claude Code CLI process
// The SDK manages the child process lifecycle
// Messages flow bidirectionally:
//   Input:  MessageQueue.generator() → SDK → Claude Code CLI
//   Output: SDK message iterator → Process event listeners → WebSocket/SSE → client
```

**The critical component is `MessageQueue`** (`packages/server/src/sdk/messageQueue.ts`):

```typescript
// MessageQueue bridges the gap between HTTP request/WebSocket messages
// and the SDK's async generator prompt interface

const queue = new MessageQueue();

// Web client sends a message via HTTP POST /api/sessions/:id/message
queue.push({ text: "Fix the bug in auth.ts" });

// SDK consumes from the async generator
async function* generator() {
  while (true) {
    yield await queue.next();  // blocks until a message is pushed
  }
}
```

### AgentSession Interface

What's returned from `provider.startSession()`:

```typescript
interface AgentSession {
  iterator: AsyncIterableIterator<SDKMessage>;  // output stream
  queue: MessageQueue;                           // input stream
  abort: () => void;                            // kill the session
  isProcessAlive?: () => boolean;               // liveness check
  pid?: number | (() => number | undefined);    // OS process ID
  steer?: (message: UserMessage) => Promise<boolean>;  // mid-turn input
  setMaxThinkingTokens?: (tokens: number | null) => Promise<void>;
  interrupt?: () => Promise<void>;              // graceful interrupt
  supportedModels?: () => Promise<ModelInfo[]>;
  supportedCommands?: () => Promise<SlashCommand[]>;
  setModel?: (model?: string) => Promise<void>; // change model mid-session
}
```

### Remote Execution (SSH)

Sessions can run on remote machines via SSH:
- `createRemoteSpawn()` creates a spawn function that runs Claude Code via SSH
- `syncSessionFile()` uses rsync to copy session JSONL files back to local after each turn
- Path translation handles different home dirs across machines

## Multi-Client Model

### Can Multiple Clients View the Same Session?

**YES** — Multiple WebSocket/SSE clients can subscribe to the same session simultaneously.

The `Process` class maintains:
- A `Set<Listener>` for event subscribers (no limit on count)
- A two-bucket message buffer (15s rotation) for replay to late-joining clients
- Accumulated `streamingText` for catch-up when clients connect mid-stream

When a client connects to a session stream:
1. Current state snapshot is sent (session info, pending approvals, streaming text)
2. Recent messages are replayed from the bucket buffer (15-30s of history)
3. Ongoing events are forwarded in real-time

### Can Web + Terminal Co-Exist?

**Partially** — with important caveats:

**Scenario 1: Terminal starts session, web observes (READ-ONLY)**
- Terminal runs `claude` and starts working
- FileWatcher detects JSONL writes
- ExternalSessionTracker marks session as `{ owner: "external" }`
- Web UI shows the session with real-time updates (via file polling)
- Web **cannot send input** to the terminal session
- Web **cannot approve tools** for the terminal session
- This is observation-only — the terminal has full control

**Scenario 2: Web starts session, terminal is not involved**
- Web UI starts a session via the server
- Server spawns Claude Code CLI via SDK `query()`
- Full bidirectional control: send messages, approve/deny tools, abort
- Terminal is not involved at all

**Scenario 3: Web resumes a session that was started in terminal**
- Session was started in terminal, terminal exits
- Web UI can resume the session using the session ID
- Server spawns a NEW Claude Code CLI process with `resume: sessionId`
- Full control transfers to the web (it's now a server-owned session)
- If terminal resumes the same session simultaneously, there's a conflict
  (both would try to append to the same JSONL file — undefined behavior)

### Key Limitation: No Session Sharing

YepAnywhere does NOT support simultaneous control from multiple programs. The ownership model is exclusive:
- `{ owner: "self" }` — server has full control
- `{ owner: "external" }` — terminal has control, server observes
- `{ owner: "none" }` — nobody is actively using it

There is no "session handoff" protocol. If you want to move from terminal to web, you must:
1. Exit the terminal session
2. Resume from the web UI (which spawns a new process)

## Session Lifecycle

### State Machine

```
                    ┌────────────────┐
                    │   (not started) │
                    └────────┬───────┘
                             │ startSession() / resumeSession()
                             ▼
                    ┌────────────────┐
              ┌────>│    in-turn     │<────────┐
              │     │ (agent working) │         │
              │     └────────┬───────┘         │
              │              │ tool approval   │ user sends message
              │              ▼                 │
              │     ┌────────────────┐         │
              │     │ waiting-input  │         │
              │     │ (needs approval)├─────────┘
              │     └────────┬───────┘
              │              │ turn completes
              │              ▼
              │     ┌────────────────┐
              │     │     idle       │
              │     │ (waiting msg)  ├──────────┘ user sends message
              │     └────────┬───────┘
              │              │ idle timeout (configurable)
              │              ▼
              │     ┌────────────────┐
              └─────┤  terminated    │
                    │ (process dead) │
                    └────────────────┘
```

### Stale Detection

Every 60 seconds, the Supervisor checks for stale processes:
- In-turn processes with no SDK messages for 5 minutes are terminated
- Processes where `isProcessAlive()` returns false are terminated
- Up to 50 terminated process records retained for 10 minutes

### Idle Timeout and Preemption

When `maxWorkers` is set:
- If at capacity, the Supervisor looks for idle processes to preempt
- Idle preemption threshold: configurable (default from types)
- If no preemptable worker exists, request goes to WorkerQueue
- Queue has configurable max size; returns `queue_full` error when exceeded

## Session Metadata

Each session has:
- **Auto-derived**: title (first user message), messageCount, createdAt, updatedAt, contextUsage, model
- **User-set**: customTitle, isArchived, isStarred
- **Runtime**: ownership, activity (in-turn/waiting-input/idle), pendingInputType, provider

The `SessionView` class (shared package) provides a unified read interface.
The `Session` class (server) adds I/O: rename, archive, star, refresh from disk.

## Real-Time Streaming Architecture

```
Process events → createSessionSubscription() → emit() → WebSocket/SSE → Client

Subscription events:
  "connected"          — initial state snapshot + replay buffer
  "message"            — SDK message (assistant text, tool calls, results)
  "markdown-augment"   — server-rendered HTML for code blocks
  "pending"            — pending tool approval notifications
  "state"              — process state changes
  "heartbeat"          — keepalive (30s interval)
  "completed"          — process terminated
```

The `StreamAugmenter` enriches messages in real-time:
- Syntax highlighting via shiki for code blocks in markdown
- Unified diff computation for Edit tool calls
- Read file content augmentation
- All computed server-side so mobile clients don't need heavy JS

## Key Patterns for autonomOS

1. **FileWatcher + EventBus** — Decoupled file monitoring → event emission. Clean, reusable.
2. **ExternalSessionTracker** — Detect external activity via JSONL file writes. Decay-based ownership.
3. **AgentProvider interface** — Clean abstraction over multiple AI agent runtimes. Extensible.
4. **MessageQueue async generator** — Bridge between HTTP/WS and SDK's streaming prompt interface.
5. **Process state machine** — Well-defined lifecycle with proper cleanup and stale detection.
6. **Two-bucket SSE replay** — Bounded memory for late-joining client catch-up.
7. **Server-side stream augmentation** — Offload heavy rendering from mobile clients.
