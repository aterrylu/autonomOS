# Mission Control — Patterns to Steal vs Rethink

What to borrow directly, what to adapt, and what to do differently for autonomOS.

## Steal These (Copy the Pattern)

### 1. Event Bus → SSE → Client Store

This is the best pattern in the codebase. **Copy it directly.**

```
Server mutation → eventBus.broadcast('entity.action', data)
                      ↓
              SSE stream (/api/events) → EventSource client
                      ↓
              useServerEvents hook → Zustand dispatch (addTask, updateAgent, etc.)
                      ↓
              React re-render (only affected components)
```

Why it works:
- **Decoupled** — any code that writes to DB can broadcast events. The SSE handler and webhooks listen independently.
- **Instant UI** — no polling needed. DB write → UI update in milliseconds.
- **Simple** — just a Node.js EventEmitter singleton. No Redis, no message queue.
- **Survives HMR** — uses `globalThis` to persist across hot reloads.

For autonomOS: put this in `packages/core` as a shared primitive. Dashboard subscribes, robot controller subscribes, CLI subscribes — same bus.

### 2. Thin Routes, Thick Lib

Every API route follows the same 6-step pattern:

```typescript
// 1. Auth
const auth = requireRole(request, 'operator')
if ('error' in auth) return NextResponse.json(...)

// 2. Rate limit
const limited = mutationLimiter(request)
if (limited) return limited

// 3. Validate (Zod)
const validation = await validateBody(request, schema)
if ('error' in validation) return validation.error

// 4. Business logic (lib/ functions)
// 5. Broadcast events
// 6. Return response
```

Routes are 30-150 lines. All logic is in `lib/`. Makes everything testable.

For autonomOS: same pattern. Keep route files as thin adapters.

### 3. Centralized Config Object

```typescript
// lib/config.ts
export const config = {
  claudeHome: process.env.MC_CLAUDE_HOME || path.join(os.homedir(), '.claude'),
  dbPath: process.env.MISSION_CONTROL_DB_PATH || '.data/mission-control.db',
  openclawHome: process.env.OPENCLAW_HOME || '',
  retention: {
    activities: Number(process.env.MC_RETAIN_ACTIVITIES_DAYS || '90'),
    // ...
  },
}
```

One file, all env vars, sensible defaults. Import from anywhere.

### 4. Zod Validation Layer

One `validation.ts` file with ALL schemas:

```typescript
export const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  status: z.enum(['inbox', 'assigned', ...]).default('inbox'),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  tags: z.array(z.string()).default([]),
  // ...
})

export const updateTaskSchema = createTaskSchema.partial()
```

Every mutation endpoint calls `validateBody(request, schema)`. Clean boundary between untrusted input and business logic.

### 5. Claude Code Session Scanner

`lib/claude-sessions.ts` — port this directly to autonomOS:

1. Scan `~/.claude/projects/` for JSONL files
2. Parse line-by-line (handles large files without loading all into memory)
3. Extract: session ID, model, tokens, timestamps, activity status
4. Estimate cost per model (with cache adjustments)
5. Upsert to DB every 60 seconds

This is literally one of autonomOS's "now" priorities. Adapt the parser.

### 6. SQLite WAL Mode + Forward-Only Migrations

```typescript
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('foreign_keys = ON')
```

Migration system: array of `{ id, up(db) }` objects, tracked in `schema_migrations` table. Idempotent DDL. No rollback. Simple and effective.

### 7. Dual-Mode Dashboard

The `dashboardMode: 'full' | 'local'` pattern is smart:

```typescript
// On startup:
fetch('/api/status?action=capabilities')
  .then(data => {
    if (data.gateway === false) {
      setDashboardMode('local')      // Hide gateway-dependent UI
      setGatewayAvailable(false)     // Skip WebSocket connect
    }
  })
```

For autonomOS: we need the same. Dashboard should work without any agent runtime. "Local mode" = just Claude Code session tracking and manual task management. "Connected mode" = live agent data from OpenClaw/other runtimes.

### 8. useSmartPoll (Visibility-Aware Polling)

```typescript
// Pauses polling when tab is hidden, resumes when visible
// Also uses document.visibilitychange event
export function useSmartPoll(url, interval, enabled) {
  // Only fetch when tab is visible AND enough time has passed
}
```

Small but important for battery/network efficiency.

## Adapt These (Take the Concept, Change the Implementation)

### 1. Agent Abstraction

MC's agent is just a DB row:
```typescript
interface Agent {
  id: number; name: string; role: string;
  status: 'offline' | 'idle' | 'busy' | 'error';
  config?: string; // JSON blob from openclaw.json
}
```

**Rethink for autonomOS:** We need richer agent modeling in `packages/core`:
- **Capabilities** — what can this agent do? (file access, web, tools, actuators)
- **Runtime** — which runtime is it on? (OpenClaw, Claude Code, custom, robot controller)
- **Memory state** — what does it know? Memory file paths, knowledge cutoff
- **Identity** — persistent identity across sessions (SOUL.md, personality, role)
- **Health** — structured health checks, not just last_seen timestamp

### 2. Frontend Routing

MC uses a switch statement for routing. No URLs, no deep linking:
```typescript
function ContentRouter({ tab }) {
  switch (tab) {
    case 'overview': return <Dashboard />
    case 'tasks': return <TaskBoardPanel />
    // ...
  }
}
```

**Rethink:** Use Next.js App Router properly from the start:
```
app/
  (dashboard)/
    page.tsx          → /dashboard (overview)
    agents/page.tsx   → /dashboard/agents
    tasks/page.tsx    → /dashboard/tasks
    tokens/page.tsx   → /dashboard/tokens
```

Benefits: URL-based routing, browser history, deep linking, shareable URLs.

### 3. State Management

MC uses one monolithic 760-line Zustand store.

**Rethink:** Slice by feature from the start:
```
store/
  agents.ts      # Agent state + actions
  tasks.ts       # Task state + actions
  sessions.ts    # Session state + actions
  ui.ts          # UI preferences
  connection.ts  # WebSocket/SSE connection state
  index.ts       # Combine with zustand/combine or just re-export
```

### 4. Webhook System

MC's webhook system is well-built but complex (retry, circuit breaker, delivery history). For autonomOS v1:

**Simplify:** Start with just the event bus broadcasting. Add webhooks later when there's a real use case. The bus pattern makes it easy to add consumers later.

### 5. Auth

MC has session cookies + API keys + Google OAuth + RBAC (3 roles).

**Simplify for v1:** It's a personal tool. Start with just an API key or even no auth (localhost only). Add proper auth when/if you share it.

## Rethink These (Different Approach Needed)

### 1. Provider Adapter Pattern

MC is hardcoded to OpenClaw:
- `agent-sync.ts` reads `openclaw.json`
- `websocket.ts` speaks OpenClaw protocol v3
- Config assumes `OPENCLAW_HOME`

**autonomOS needs:**
```typescript
// packages/core/src/providers/interface.ts
interface AgentProvider {
  name: string
  connect(): Promise<void>
  disconnect(): Promise<void>
  listAgents(): Promise<Agent[]>
  getAgentStatus(id: string): Promise<AgentStatus>
  onEvent(handler: (event: AgentEvent) => void): void
}

// packages/core/src/providers/openclaw.ts
class OpenClawProvider implements AgentProvider { ... }

// packages/core/src/providers/claude-code.ts
class ClaudeCodeProvider implements AgentProvider { ... }

// Future: packages/core/src/providers/robot-controller.ts
class RobotControllerProvider implements AgentProvider { ... }
```

This is the key architectural difference. MC is a dashboard FOR OpenClaw. autonomOS is a dashboard for ANY agent runtime.

### 2. Core vs Dashboard Split

MC is monolithic — everything in one Next.js app. For autonomOS:

```
packages/core/           # Zero UI dependency
  src/
    agents/              # Agent abstraction + lifecycle
    events/              # Event bus (works in any runtime)
    providers/           # Runtime adapters (OpenClaw, CC, robot)
    persistence/         # SQLite layer (or abstract further)
    scheduling/          # Background tasks
    types/               # Shared TypeScript types

packages/dashboard/      # Web UI, depends on core
  src/
    app/                 # Next.js routes
    components/          # React panels
    store/               # Zustand (consumes core events)
    lib/                 # Dashboard-specific utilities
```

The `core` package should work headless — a CLI tool, a robot controller, or a test harness should all be able to use it without the dashboard.

### 3. Robot Path Considerations

MC has zero concept of:
- **Topics** (pub/sub sensor/actuator channels)
- **Continuous operation** (agents run forever, not session-based)
- **Hardware health** (battery, thermal, connectivity)
- **Physical state** (position, joint angles, sensor readings)

These don't need to be built now, but the core abstractions shouldn't preclude them. An "agent" should be generic enough that a coding agent and a robot controller are both valid instances.

### 4. Observability Depth

MC tracks:
- Agent status (4 states: offline/idle/busy/error)
- Token usage (input/output/cost)
- Activity stream (human-readable descriptions)

autonomOS should eventually add:
- **Agent decision traces** — why did the agent do what it did?
- **Memory diff** — what changed in the agent's memory after a session?
- **Tool call patterns** — what tools does this agent use most?
- **Performance metrics** — latency per operation, success/failure rates
- **Cost forecasting** — based on usage trends, predict future spend

## Implementation Priority for autonomOS

Based on studying MC, here's what I'd build first:

### Phase 1: Foundation (What MC's lib/ gives you)
1. SQLite setup with WAL + migrations (copy MC's pattern)
2. Event bus singleton (copy directly)
3. Config object with env var defaults (copy)
4. Claude Code session scanner (port from MC)
5. Basic API with SSE stream (copy route pattern)

### Phase 2: Dashboard MVP (What MC's panels give you)
1. Session list panel (active Claude Code sessions)
2. Token usage / cost panel (Recharts)
3. Agent status panel (registered agents)
4. Activity feed (event stream)

### Phase 3: Agent-Agnostic (Where autonomOS diverges)
1. Provider adapter interface
2. OpenClaw provider
3. Claude Code provider (upgrade scanner to full provider)
4. Multi-provider dashboard UI

## File-Level Mapping

Files from MC's `lib/` that directly map to autonomOS's needs:

| MC File | autonomOS Equivalent | Action |
|---------|---------------------|--------|
| `config.ts` | `packages/core/src/config.ts` | Copy + adapt |
| `db.ts` | `packages/core/src/persistence/db.ts` | Copy + adapt |
| `migrations.ts` | `packages/core/src/persistence/migrations.ts` | Copy pattern, own schema |
| `event-bus.ts` | `packages/core/src/events/bus.ts` | Copy directly |
| `claude-sessions.ts` | `packages/core/src/providers/claude-code.ts` | Port + extend |
| `validation.ts` | `packages/dashboard/src/lib/validation.ts` | Copy pattern |
| `rate-limit.ts` | Not needed for v1 | Skip |
| `auth.ts` | Not needed for v1 | Skip |
| `webhooks.ts` | Not needed for v1 | Skip |
| `scheduler.ts` | `packages/core/src/scheduling/scheduler.ts` | Simplified copy |
| `websocket.ts` | `packages/dashboard/src/lib/use-gateway.ts` | Adapt for provider pattern |
| `use-server-events.ts` | `packages/dashboard/src/lib/use-events.ts` | Copy + adapt |
| `agent-sync.ts` | Replaced by provider pattern | Rethink |
| `models.ts` | `packages/core/src/models.ts` | Copy + extend |
