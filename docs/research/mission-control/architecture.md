# Mission Control — Architecture Deep Dive

## 1. High-Level Architecture

Mission Control is a **monolithic full-stack app** — a single Next.js 16 process runs everything: REST API, SSE streaming, background scheduling, and the React SPA. No microservices, no external queues. SQLite is the only runtime dependency.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         BROWSER (SPA)                               │
│                                                                     │
│  ┌─────────┐  ┌──────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Zustand  │  │ 26 Panel │  │ useServerEvt │  │  useWebSocket   │  │
│  │  Store   │←─│Components│  │  (SSE hook)  │  │ (Gateway hook)  │  │
│  │ (single) │  └──────────┘  └──────┬───────┘  └───────┬─────────┘  │
│  └────┬─────┘                       │                   │           │
│       │ fetch()                EventSource          WebSocket       │
├───────┼─────────────────────────────┼───────────────────┼───────────┤
│       │            NEXT.JS SERVER   │                   │           │
│       ▼                             ▼                   │           │
│  ┌─────────┐    ┌────────────────────────┐              │           │
│  │ 64 REST │───▶│    Event Bus           │              │           │
│  │  Routes │    │ (Node EventEmitter)    │              │           │
│  └────┬────┘    │                        │              │           │
│       │         │ ┌──▶ SSE stream ───────┘              │           │
│       │         │ │   (/api/events)                     │           │
│       │         │ │                                     │           │
│       │         │ └──▶ Webhooks ──▶ external URLs       │           │
│       ▼         └────────────────────────┘              │           │
│  ┌──────────┐   ┌────────────┐                          │           │
│  │ SQLite   │   │ Scheduler  │                          │           │
│  │ (WAL)    │   │ (setInterval, 60s tick)               │           │
│  │ .data/   │   │ backup, cleanup, heartbeat,           │           │
│  │  mc.db   │   │ webhook retry, claude scan            │           │
│  └──────────┘   └────────────┘                          │           │
│                                                         │           │
│                              ┌───────────────────────────┘           │
│                              ▼                                      │
│                    ┌──────────────────┐                              │
│                    │ OpenClaw Gateway │ (external, optional)        │
│                    │ WS protocol v3   │                              │
│                    └──────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Insight

The app operates in **two distinct modes**:
- **`full` mode** — connected to an OpenClaw gateway via WebSocket. Gets live sessions, logs, token usage from the gateway.
- **`local` mode** — standalone, no gateway. All data comes from the SQLite DB and local filesystem scanning.

This dual-mode design means every feature must degrade gracefully when no gateway is present. The frontend detects this via `GET /api/status?action=capabilities` which returns `{ gateway: false }` when `OPENCLAW_HOME` isn't set.

## 2. Folder Structure

```
src/
├── middleware.ts              # Next.js edge middleware — auth + CSRF + host allowlist
├── types/index.ts             # Frontend-facing TypeScript interfaces
├── store/index.ts             # Zustand store — single 760-line file, ALL client state
│
├── app/
│   ├── page.tsx               # SPA shell — NavRail + HeaderBar + ContentRouter
│   ├── layout.tsx             # Root layout (ThemeProvider, globals.css)
│   ├── login/page.tsx         # Login page
│   ├── docs/page.tsx          # Scalar OpenAPI docs viewer
│   └── api/                   # 64 route files (see API section below)
│       ├── auth/              # login, logout, me, google, users, access-requests
│       ├── agents/            # CRUD, heartbeat, wake, soul, memory, sync, comms
│       ├── tasks/             # CRUD, comments, broadcast
│       ├── chat/              # conversations, messages
│       ├── webhooks/          # CRUD, test, retry, deliveries, verify-docs
│       ├── sessions/          # list, control (monitor/pause/terminate)
│       ├── super/             # tenants, provision-jobs
│       ├── claude/            # sessions (local Claude Code tracking)
│       └── ...                # events(SSE), status, tokens, alerts, etc.
│
├── components/
│   ├── ErrorBoundary.tsx      # React error boundary wrapping each panel
│   ├── layout/                # NavRail, HeaderBar, LiveFeed, LocalModeBanner
│   ├── dashboard/             # Overview: stats grid, session list, agent network graph
│   ├── panels/                # 26 feature panels
│   │   ├── task-board-panel.tsx         # Kanban board
│   │   ├── agent-squad-panel-phase3.tsx # Agent registry + detail tabs
│   │   ├── token-dashboard-panel.tsx    # Cost tracking with Recharts
│   │   ├── session-details-panel.tsx    # Gateway session inspector
│   │   ├── webhook-panel.tsx            # Webhook management
│   │   ├── memory-browser-panel.tsx     # File browser for agent memory
│   │   ├── super-admin-panel.tsx        # Multi-tenant provisioning
│   │   └── ...                          # 20 more panels
│   ├── chat/                  # ChatPanel, ConversationList, MessageList
│   └── ui/                    # DigitalClock, ThemeToggle, OnlineStatus
│
└── lib/                       # Server-side core logic (THE BACKBONE)
    ├── db.ts                  # SQLite singleton, entity types, helper functions
    ├── config.ts              # Centralized env-var config object
    ├── migrations.ts          # 20 sequential schema migrations
    ├── schema.sql             # Base schema (migration 001)
    ├── auth.ts                # Session management, user CRUD, RBAC
    ├── password.ts            # scrypt hashing
    ├── google-auth.ts         # Google Sign-In token verification
    ├── event-bus.ts           # EventEmitter singleton — bridges DB→SSE→webhooks
    ├── webhooks.ts            # Outbound delivery, retry, circuit breaker, HMAC
    ├── scheduler.ts           # Background tasks (backup, cleanup, heartbeat, scan)
    ├── websocket.ts           # CLIENT-SIDE React hook for gateway WebSocket
    ├── use-server-events.ts   # CLIENT-SIDE React hook for SSE
    ├── use-smart-poll.ts      # Polling that pauses on tab blur (visibility API)
    ├── claude-sessions.ts     # Scans ~/.claude/projects/ JSONL for session tracking
    ├── agent-sync.ts          # Syncs agents from openclaw.json → SQLite
    ├── agent-templates.ts     # SOUL.md template loading from filesystem
    ├── models.ts              # Static model catalog (8 models, multi-provider)
    ├── validation.ts          # Zod schemas for ALL API inputs
    ├── rate-limit.ts          # In-memory IP rate limiter with proxy chain walking
    ├── logger.ts              # Pino structured logging
    ├── github.ts              # GitHub Issues sync (inbound)
    ├── super-admin.ts         # Multi-tenant provisioning logic
    └── utils.ts               # General utilities
```

**Key pattern:** `lib/` is the backbone. Every API route is a thin adapter (30-150 lines) that delegates to `lib/` for auth, validation, business logic, and event broadcasting.

## 3. Data Flow — The Event Bus

The event bus in `lib/event-bus.ts` is the nervous system of the entire app. It's a singleton `EventEmitter` that survives HMR via `globalThis`:

```
ANY SERVER-SIDE CODE (API route, scheduler, agent-sync)
    │
    │ eventBus.broadcast('task.created', payload)
    │
    ▼
EventBus (Node.js EventEmitter, singleton via globalThis)
    │
    ├───▶ SSE handler in /api/events
    │     │ Encodes to: `data: ${JSON.stringify(event)}\n\n`
    │     │ Sends to: all connected EventSource clients
    │     ▼
    │     useServerEvents hook (client-side)
    │     │ Dispatches to Zustand: addTask(), updateAgent(), etc.
    │     ▼
    │     React re-renders relevant panels
    │
    └───▶ Webhook listener (initWebhookListener)
          │ Maps event types: 'activity.created' → 'activity.task_created'
          │ Filters enabled webhooks by subscribed events
          ▼
          HTTP POST to webhook URLs (with HMAC signature, retry logic)
```

**34 event types** are defined:
- Task: `task.created`, `task.updated`, `task.deleted`, `task.status_changed`
- Agent: `agent.created`, `agent.updated`, `agent.deleted`, `agent.synced`, `agent.status_changed`
- Chat: `chat.message`, `chat.message.deleted`
- Other: `notification.created`, `activity.created`, `audit.security`, `connection.created`, `github.synced`

## 4. Two Real-Time Channels

| Channel | Direction | Protocol | Purpose | Always Active? |
|---------|-----------|----------|---------|---------------|
| **SSE** (`/api/events`) | Server → Browser | EventSource | Local DB mutations | Yes (even local mode) |
| **WebSocket** (gateway) | Browser ↔ Gateway | WS, protocol v3 | Sessions, logs, token usage, cron | Only in `full` mode |

The SSE channel handles **everything stored in SQLite** — tasks, agents, chat, activities, notifications. The WebSocket handles **gateway-provided data** — live sessions, logs, token usage events.

**This dual-channel design is why local mode works.** SSE alone provides full reactivity for locally-generated data. The WebSocket is an enhancement, not a requirement.

### SSE Implementation

```typescript
// Server: /api/events/route.ts
export async function GET(request: NextRequest) {
  // Auth check, then create ReadableStream
  const stream = new ReadableStream({
    start(controller) {
      // Forward all events from the bus
      eventBus.on('server-event', (event) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      })
      // Heartbeat every 30s to keep alive through proxies
      setInterval(() => controller.enqueue(encoder.encode(': heartbeat\n\n')), 30_000)
    },
    cancel() { /* cleanup listeners */ }
  })
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
}

// Client: lib/use-server-events.ts
export function useServerEvents() {
  useEffect(() => {
    const es = new EventSource('/api/events')
    es.onmessage = (event) => {
      const payload = JSON.parse(event.data)
      switch (payload.type) {
        case 'task.created': addTask(payload.data); break
        case 'agent.status_changed': updateAgent(payload.data.id, payload.data); break
        // ... dispatch to Zustand for each event type
      }
    }
  }, [])
}
```

### WebSocket Gateway Protocol v3

```
Browser                          OpenClaw Gateway
  |--- WebSocket connect --------->|
  |<-- connect.challenge (nonce) --|
  |--- connect req (auth, scopes)->|
  |<-- res (ok: true) ------------|    ← "handshake complete"
  |                                |
  |--- ping req (every 30s) ------>|   ← heartbeat
  |<-- pong res (RTT measured) ----|
  |                                |
  |<-- event (tick: sessions) -----|   ← periodic snapshot
  |<-- event (log: entry) --------|   ← real-time log
  |<-- event (chat.message) ------|   ← agent chat
  |<-- event (agent.status) ------|   ← status change
```

If 3 consecutive pongs are missed, the client force-closes and reconnects with exponential backoff (up to 10 attempts, max 30s delay with jitter).

## 5. Frontend Architecture

### SPA Shell Pattern

The entire app is a single page (`page.tsx`) with client-side routing via a switch statement:

```typescript
// page.tsx
export default function Home() {
  const { activeTab } = useMissionControl()

  useServerEvents()  // Connect SSE
  useWebSocket()     // Connect gateway (if available)

  return (
    <div className="flex h-screen">
      <NavRail />                     {/* Left: icon navigation */}
      <div className="flex-1">
        <HeaderBar />
        <LocalModeBanner />           {/* Shows when no gateway */}
        <ErrorBoundary key={activeTab}>
          <ContentRouter tab={activeTab} />
        </ErrorBoundary>
      </div>
      {liveFeedOpen && <LiveFeed />}  {/* Right: activity stream */}
      <ChatPanel />                    {/* Overlay: agent chat */}
    </div>
  )
}

function ContentRouter({ tab }) {
  switch (tab) {
    case 'overview': return <Dashboard />
    case 'tasks':    return <TaskBoardPanel />
    case 'agents':   return <AgentSquadPanelPhase3 />
    case 'tokens':   return <TokenDashboardPanel />
    // ... 26 panels total
  }
}
```

**Each panel is wrapped in ErrorBoundary with `key={activeTab}`** — if a panel crashes, only that panel shows an error message, and switching tabs resets it.

### State Management

One monolithic Zustand store (`store/index.ts`, ~760 lines) manages ALL client state:
- Dashboard mode, gateway availability
- WebSocket/SSE connection status
- Tasks, agents, activities, notifications, comments
- Chat messages, conversations
- Sessions, logs, spawn requests, cron jobs
- Memory browser, token usage, model configs
- Auth (current user), UI state (active tab, sidebar, live feed)

Uses `subscribeWithSelector` middleware for efficient subscriptions — components only re-render when their specific slice changes.

**UI state persists to localStorage:** sidebar expanded state, collapsed nav groups, live feed visibility.

### Data Loading Pattern

1. **On mount:** Fetch `/api/auth/me` and `/api/status?action=capabilities`
2. **Per panel:** Each panel fetches its data on activation via `useEffect` + `fetch()`
3. **Real-time:** SSE pushes mutations instantly → `useServerEvents` → Zustand
4. **Fallback:** `useSmartPoll` provides polling that pauses when tab is hidden

## 6. Backend Architecture

### API Route Pattern (consistent across all 64 routes)

```typescript
export async function POST(request: NextRequest) {
  // 1. Auth check (returns user or 401/403)
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  // 2. Rate limiting
  const limited = mutationLimiter(request)
  if (limited) return limited

  // 3. Input validation (Zod schema)
  const validation = await validateBody(request, createTaskSchema)
  if ('error' in validation) return validation.error

  // 4. Business logic
  const db = getDatabase()
  const result = db.prepare('INSERT INTO tasks ...').run(...)

  // 5. Side effects: event broadcasting + activity logging
  eventBus.broadcast('task.created', payload)
  db_helpers.logActivity('task_created', 'task', id, actor, description)

  // 6. Response
  return NextResponse.json({ task: result })
}
```

### Auth System

Three auth methods:
1. **Session cookie** (`mc-session`): 32-byte random token, 7-day expiry, scrypt passwords
2. **API key** (`x-api-key` header): Constant-time comparison, returns synthetic admin user
3. **Google Sign-In**: OAuth → access request → admin approval → user creation

RBAC hierarchy: `viewer` (read) < `operator` (read+write) < `admin` (full)

### Rate Limiting

In-memory, per-IP, with trusted proxy chain walking:

| Limiter | Window | Max | Used On |
|---------|--------|-----|---------|
| `loginLimiter` | 60s | 5 | Login (critical, can't disable) |
| `mutationLimiter` | 60s | 60 | POST/PUT/DELETE routes |
| `readLimiter` | 60s | 120 | GET routes |
| `heavyLimiter` | 60s | 10 | Export, backup, search |

### Background Scheduler

In-process `setInterval` loop, ticks every 60 seconds:

| Task | Interval | Purpose |
|------|----------|---------|
| `auto_backup` | Daily 3AM UTC | SQLite `.backup()` + prune old backups |
| `auto_cleanup` | Daily 4AM UTC | Delete stale records per retention config |
| `agent_heartbeat` | 5 min | Mark agents offline if no heartbeat |
| `webhook_retry` | 60s | Process pending webhook retries |
| `claude_session_scan` | 60s | Scan `~/.claude/projects/` for sessions |

Each task reads its enabled/disabled state from the `settings` DB table — runtime-configurable via the Settings panel.

### Webhook System

Production-grade outbound webhooks:
- **Event matching:** Wildcards (`*`) or specific types (`activity.task_created`)
- **HMAC-SHA256 signing:** Secret in `X-MC-Signature` header, constant-time verification
- **Exponential backoff retry:** 30s → 5m → 30m → 2h → 8h (±20% jitter)
- **Circuit breaker:** Auto-disables after 5 consecutive failures
- **Delivery history:** Last 200 per webhook, with status codes + response bodies

## 7. Configuration

All config flows from environment variables through `lib/config.ts`:

```typescript
export const config = {
  claudeHome: process.env.MC_CLAUDE_HOME || path.join(os.homedir(), '.claude'),
  dataDir: process.env.MISSION_CONTROL_DATA_DIR || '.data',
  dbPath: process.env.MISSION_CONTROL_DB_PATH || '.data/mission-control.db',
  tokensPath: process.env.MISSION_CONTROL_TOKENS_PATH || '.data/mission-control-tokens.json',
  openclawHome: process.env.OPENCLAW_HOME || '',
  gatewayHost: process.env.OPENCLAW_GATEWAY_HOST || '127.0.0.1',
  gatewayPort: Number(process.env.OPENCLAW_GATEWAY_PORT || '18789'),
  logsDir: ...,
  memoryDir: ...,
  soulTemplatesDir: ...,
  retention: {
    activities: Number(process.env.MC_RETAIN_ACTIVITIES_DAYS || '90'),
    auditLog: Number(process.env.MC_RETAIN_AUDIT_DAYS || '365'),
    // ...
  },
}
```

**Everything has sensible defaults.** The app works with zero env vars set (falls back to `.data/` for SQLite, `~/.claude` for Claude home, localhost for gateway).

## 8. Claude Code Session Tracking

`lib/claude-sessions.ts` — this is directly relevant to autonomOS:

1. Reads directories under `~/.claude/projects/`
2. For each project, finds `.jsonl` transcript files
3. Parses each JSONL line by line, extracting:
   - Session ID, model, git branch, project path
   - Message counts (user, assistant, tool uses) — skips sidechain/subagent messages
   - Token usage (input, output, cache read, cache creation)
   - Timestamps (first message, last message, last user prompt)
4. Estimates cost using per-model pricing with cache adjustment:
   - Cache reads = 10% of input cost
   - Cache creation = 125% of input cost
5. "Active" = last message within 5 minutes
6. Upserts into `claude_sessions` table (ON CONFLICT UPDATE)

Runs every 60 seconds via the scheduler. Lightweight — mostly filesystem `stat()` calls.

## 9. Security Model Summary

| Layer | Implementation |
|-------|---------------|
| Auth gate | Next.js middleware blocks all non-auth routes |
| RBAC | `requireRole(request, minRole)` — viewer < operator < admin |
| CSRF | Origin header validation on mutating requests |
| Host allowlist | `MC_ALLOWED_HOSTS` with wildcard patterns |
| Rate limiting | Per-IP, trusted proxy chain walking |
| Input validation | Zod schemas on every mutation |
| Password hashing | scrypt with 12-char minimum |
| Constant-time comparison | `timingSafeEqual` for tokens, API keys, webhook sigs |
| CSP | `script-src 'self' 'unsafe-inline'` |
| Security headers | X-Frame-Options: DENY, nosniff, strict referrer |
| Audit logging | All security events logged to `audit_log` table |
