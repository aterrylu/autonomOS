# OpenClaw — Sessions, Memory, and Cron

## 1. Session Model

### Session Identity

Sessions are identified by a **session key** — a normalized string derived from the sender's identity across channels:
- Telegram: user ID
- Discord: member ID
- Slack: user ID
- WhatsApp: phone number
- Signal: phone number
- iMessage: email/phone

Session keys are normalized (trimmed, lowercased) to handle case variations.

### Session Storage

**Location:** `~/.openclaw/sessions.json`

Sessions are stored in a **JSON file-based key-value store** with:
- **Atomic writes** — temp file + rename pattern prevents corruption
- **In-memory cache** — 45-second TTL (configurable) for read performance
- **Write lock queue** — `withSessionStoreLock()` serializes concurrent writes
- **Auto-maintenance** — prunes stale entries, caps total count, rotates file at size threshold

### SessionEntry Structure

```typescript
SessionEntry {
  sessionId: string;           // Unique UUID
  sessionKey: string;          // Normalized sender key
  updatedAt: number;           // Timestamp of last activity

  // Session type
  state: "main" | "isolated";  // Direct chat vs subagent/thread

  // Runtime metadata
  model: string;               // Active model
  provider: string;            // LLM provider
  thinkingLevel: string;       // low/medium/high
  verboseLevel: string;
  reasoningLevel: string;
  tokenUsage: { input, output, cacheRead, cacheCreation };

  // Delivery context
  channel: string;             // telegram, discord, slack, etc.
  to: string;                  // Recipient identifier
  accountId: string;           // Account/agent identifier
  threadId: string;            // Thread/conversation ID

  // ACP metadata (Agent Control Protocol)
  identity: { name, theme, emoji, avatar };
  mode: "persistent" | "oneshot";
  runtimeState: object;

  // Agent context
  skillsSnapshot: string[];
  systemPromptReport: string;
}
```

### Session Lifecycle

```
1. CREATION — Message arrives from new sender
   → recordSessionMetaFromInbound()
   → Assigns sessionId, sessionKey, channel, model

2. ACTIVE — Agent processes messages
   → Each turn updates: model, tokenUsage, updatedAt
   → Transcript persisted to disk

3. RESET — User triggers /new or /reset, or idle timeout
   → Session memory optionally saved (session-memory hook)
   → New sessionId generated
   → Transcript cleared

4. PRUNED — Stale session cleanup
   → After configurable idle period (default 60 minutes)
   → Store maintenance runs periodically
```

### Session Scoping Configuration

```typescript
SessionConfig {
  scope: "per-sender" | "global";  // One session per sender or shared
  dmScope: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  reset: {
    mode: "daily" | "idle";
    atHour: 0-23;              // For daily reset
    idleMinutes: number;       // For idle reset
  };
  resetByType: { direct?, group?, thread? };  // Per chat type
  resetByChannel: Record<channelId, ResetConfig>;  // Per channel
  maintenance: {
    pruneAfter: string;        // Age to prune (e.g., "7d")
    maxEntries: number;
    rotateBytes: number;
    maxDiskBytes: number;
  };
}
```

### Session Transcripts

Agent conversation transcripts are stored separately from session metadata:
- **Location:** `~/.openclaw/sessions/` (or per-agent workspace)
- **Format:** Session transcript files (not JSONL — internal format)
- **Per-session:** Each session ID maps to a transcript
- **Compaction:** Overflow handling compacts older messages to save context window

---

## 2. Memory System

### Architecture

OpenClaw's memory layer is a **vector database** built on **sqlite-vec** with hybrid search:

```
┌──────────────────────────────────────────────┐
│              Memory Manager                   │
│         (MemoryIndexManager)                  │
├──────────────────────────────────────────────┤
│                                              │
│  ┌─────────────┐    ┌─────────────────────┐  │
│  │ Embedding    │    │ SQLite Database     │  │
│  │ Pipeline     │    │                     │  │
│  │              │    │ ┌─────────────────┐ │  │
│  │ OpenAI       │───▶│ │ chunks_vec      │ │  │  ← Vector table
│  │ Mistral      │    │ │ (sqlite-vec)    │ │  │
│  │ Voyage       │    │ ├─────────────────┤ │  │
│  │ Gemini       │    │ │ chunks_fts      │ │  │  ← FTS5 table
│  │ Ollama       │    │ │ (full-text)     │ │  │
│  │              │    │ ├─────────────────┤ │  │
│  └─────────────┘    │ │ embedding_cache  │ │  │
│                      │ └─────────────────┘ │  │
│                      └─────────────────────┘  │
│                                              │
│  ┌─────────────┐    ┌─────────────────────┐  │
│  │ File Watcher │    │ Search Engine       │  │
│  │ (chokidar)   │    │                     │  │
│  │              │    │ Vector search       │  │
│  │ Watches      │    │ + BM25 keyword      │  │
│  │ workspace    │    │ = Hybrid scoring    │  │
│  │ for changes  │    │ (MMR reranking)     │  │
│  └─────────────┘    └─────────────────────┘  │
└──────────────────────────────────────────────┘
```

### Key Components

**MemoryIndexManager** (`src/memory/manager.ts`):
- Singleton per agent/workspace combo (global `INDEX_CACHE`)
- Lazy initialization via `MemoryIndexManager.get()`
- File watching for workspace changes
- Session transcript syncing to vector DB
- Batch processing support (OpenAI Batch API)

**Search Operations:**
- `searchVector()` — Vector similarity search
- `searchKeyword()` — Full-text search via SQLite FTS5
- Results merged with BM25 ranking and hybrid score
- Max snippet: 700 chars per result
- MMR (Maximal Marginal Relevance) for diversity

### Memory Persistence

Memory data is stored as files in the agent workspace and indexed into the vector DB:

```
~/.openclaw/workspace/
  memory/
    YYYY-MM-DD-topic-slug.md    # Memory files (from session-memory hook)
    meeting-notes.md            # User-created memory files
    project-context.md
```

The memory manager watches these files and automatically indexes them:
1. File change detected (chokidar)
2. Content chunked into segments
3. Each chunk embedded (OpenAI/Voyage/etc.)
4. Vectors stored in sqlite-vec
5. Text indexed in FTS5
6. Available for hybrid search

### Memory Tools (Agent-Facing)

Plugins can register memory tools:
- `memory_recall` — Search memory by query
- `memory_store` — Save information to memory
- Auto-recall hook: injects relevant memories before each agent turn
- Auto-capture hook: extracts memories from completed conversations

### Embedding Providers

| Provider | Models | Batch Support |
|----------|--------|--------------|
| OpenAI | text-embedding-3-small/large, ada-002 | Yes (Batch API) |
| Mistral | mistral-embed | No |
| Voyage | voyage-3, voyage-code-3 | Yes |
| Gemini | text-embedding-004 | Yes |
| Ollama | Any local model | No |

### Memory Scoping

Memory is scoped per-agent and per-workspace:
- Each agent has its own vector DB
- Workspace files are only indexed for that workspace
- Session transcripts are synced per-session
- No cross-agent memory sharing (by design)

---

## 3. Cron / Scheduling System

### Job Definition

```typescript
CronJob {
  id: string;                          // UUID
  name: string;                        // User-friendly label
  agent: string;                       // Target agent ID

  schedule: CronSchedule;              // When to run
  // One of:
  //   { type: "at", at: "ISO-8601" }           — one-shot
  //   { type: "every", interval: "30m" }       — recurring interval
  //   { type: "cron", expression: "0 9 * * 1" } — standard cron

  sessionTarget: "main" | "isolated";  // Run in main session or isolated
  wakeMode: "next-heartbeat" | "now";  // When to trigger

  payload: CronPayload;               // What to do
  // { type: "agentTurn", message: "..." }      — run agent with message
  // { type: "systemEvent", event: "..." }      — emit system event

  delivery: CronDelivery;             // Where to send results
  // { type: "announce", channel: "telegram", to: "123" }
  // { type: "webhook", url: "https://..." }
  // { type: "none" }

  failureAlert?: CronFailureAlert;    // Failure handling
  // { enabled: true, destination: "...", cooldownMinutes: 60 }

  state: CronJobState;                // Runtime state
  // { enabled, lastRunAt, nextRunAtMs, consecutiveErrors }
}
```

### Storage

- **Job definitions:** `~/.openclaw/cron.json` (versioned store format)
- **Run logs:** `~/.openclaw/cron/runs/{jobId}.jsonl`
  - JSONL with auto-pruning (default 2MB or 2000 lines)
  - Each entry: `{ ts, jobId, status, error, sessionId, durationMs, nextRunAtMs }`

### Execution Flow

```
1. Gateway starts → loads cron.json
2. Scheduler evaluates nextRunAtMs for each job
3. When time triggers:
   a. Spawn isolated agent session with job payload
   b. Agent executes turn (may use tools, call LLM)
   c. Capture stdout/stderr and token usage
   d. Deliver output to specified channel/webhook
   e. Log result to runs/{jobId}.jsonl
   f. Update job state (lastRunAt, nextRunAtMs, errors)
```

### CLI Management

```bash
openclaw cron list              # List all jobs
openclaw cron add               # Add a new job
openclaw cron run <jobId>       # Manually trigger a job
openclaw cron logs <jobId>      # View run history
openclaw cron remove <jobId>    # Remove a job
openclaw cron status            # Overall cron status
```

### Gateway RPC Methods

| Method | Purpose |
|--------|---------|
| `cron:list` | List all cron jobs |
| `cron:add` | Create a new job |
| `cron:update` | Modify an existing job |
| `cron:remove` | Delete a job |
| `cron:run` | Manually trigger a job |
| `cron:runs` | Get run history |
| `cron:status` | Get scheduler status |

---

## Takeaway for autonomOS

### Session Model
- **Alignment:** OpenClaw's session model is sender-scoped and channel-aware — good for messaging but thin for our needs. autonomOS needs richer session modeling (capabilities, memory state, health).
- **Integration point:** `sessions:list` and `sessions:preview` gateway methods give us read access. We can observe session state without modifying it.
- **Gap:** No concept of "agent orchestration sessions" — each session is a single sender talking to a single agent. Multi-agent coordination would need to be built on top.

### Memory System
- **Alignment:** The vector DB + hybrid search pattern is exactly what we'd want. The per-agent scoping matches our agent abstraction.
- **Integration point:** Memory files live on disk (`~/.openclaw/workspace/memory/`). We can read them directly for observability. The memory manager's search API is internal (not exposed via gateway RPC).
- **Gap:** No gateway RPC method to search memory remotely. We'd need a plugin to expose this, or read files directly.

### Cron System
- **Alignment:** Close to what autonomOS needs for "automated agent schedules." The job model is clean.
- **Integration point:** Full CRUD via gateway RPC (`cron:list`, `cron:add`, `cron:update`, `cron:remove`, `cron:run`, `cron:runs`). This is a complete control surface.
- **Gap:** No webhook/event for "cron job completed" — we'd need to poll or add a hook.
