# CC-Insights -- autonomOS Integration Analysis

## 1. What CC-Insights Gets Right (learn from these patterns)

### A. EventTransport Abstraction (CRITICAL)

The single most valuable architectural pattern. CC-Insights defines a clean interface between UI and backend:

```
EventTransport
  events: Stream<InsightsEvent>           // Backend -> UI (13+ event types)
  send(BackendCommand)                    // UI -> Backend (9+ command types)
  permissionRequests: Stream<...>         // Bidirectional permission flow
```

Currently implemented as `InProcessTransport` (wraps in-process sessions), but **explicitly designed** for remote transports. autonomOS should implement:
- `WebSocketTransport` -- for web dashboard to remote session broker
- `SSETransport` -- for read-only observability from web clients
- `DockerTransport` -- for containerized agent sessions

**Why this matters:** This is the integration seam. If autonomOS implements `EventTransport` over WebSocket, it gets the full CC-Insights interaction model (messages, permissions, questions, interrupts) for free.

### B. InsightsEvent Sealed Hierarchy

Type-safe event model with 13+ subtypes covering every session lifecycle event. This is more comprehensive than mission-control's ad-hoc event bus.

**Reimplement in TypeScript:**
```typescript
type InsightsEvent =
  | SessionInitEvent
  | TextEvent
  | ToolInvocationEvent
  | ToolCompletionEvent
  | TurnCompleteEvent        // Contains token usage
  | UsageUpdateEvent         // Per-model breakdown
  | ContextCompactionEvent
  | SubagentSpawnEvent
  | SubagentCompleteEvent
  | PermissionRequestEvent
  | StreamDeltaEvent
  | SessionStatusEvent
  // ...
```

### C. Per-Model Cost Tracking

CC-Insights tracks costs per model within a session (e.g., if Claude switches from Sonnet to Opus mid-conversation). This granularity is better than MC's per-session tracking.

### D. Context Window Awareness

Live context window tracking with autocompact threshold awareness is unique. autonomOS should expose this -- users care deeply about context utilization.

### E. Timing Stats Separation

Separating "Claude working time" from "user response time" is clever. It answers "how much of this session's wall time was Claude thinking vs me being slow to approve permissions?"

### F. Session Resume Across Restarts

Storing session IDs for resume means sessions survive app crashes. autonomOS should persist session IDs in its DB.

## 2. What CC-Insights Gets Wrong (rethink for autonomOS)

### A. No External Session Discovery

CC-Insights only knows about sessions it spawns. If you run `claude` in a terminal, CC-Insights has no idea.

**autonomOS needs both:**
1. **Spawn + control** (CC-Insights approach) -- for sessions managed through the dashboard
2. **Discover + observe** (MC approach, scanning `~/.claude/projects/`) -- for sessions running elsewhere

### B. Desktop-Only, No API Surface

Flutter desktop means no REST API, no WebSocket server, no way for external tools to query session state. Everything is in-process.

**autonomOS fix:** Build the backend as a server (Node.js or Go) that exposes REST + WebSocket. The web dashboard is just one client.

### C. No Cross-Project Analytics

Each project is isolated. No way to see "how much did I spend across all projects this week?" or "which project has the most active sessions?"

**autonomOS fix:** Central DB (SQLite or Postgres) with cross-project queries. Time-series cost tracking with date range filters.

### D. No Charting

All analytics are table-based with inline indicators. No trend lines, no cost-over-time graphs, no token distribution charts.

**autonomOS fix:** Use Recharts (like MC) or similar for time-series visualization.

### E. Tightly Coupled to Dart/Flutter

The SDK types are Dart-only. No JSON schema, no protobuf, no language-agnostic definition. Reimplementing in TypeScript requires reading Dart source.

**autonomOS fix:** Define event/command schemas in JSON Schema or protobuf first, then generate TypeScript types.

### F. GPLv3 License

Cannot import any CC-Insights code into a non-GPL project. Must reimplement from patterns, not copy code.

## 3. What to Adopt vs Adapt vs Build New

### Adopt (Pattern-for-Pattern)

| Pattern | CC-Insights Source | autonomOS Implementation |
|---------|-------------------|--------------------------|
| EventTransport interface | `agent_sdk_core/transport/` | `packages/core/transport/` (TypeScript) |
| InsightsEvent hierarchy | `agent_sdk_core/types/insights_events.dart` | `packages/core/types/events.ts` (Zod schemas) |
| BackendCommand hierarchy | `agent_sdk_core/types/backend_commands.dart` | `packages/core/types/commands.ts` |
| Per-model cost tracking | `ModelUsageInfo` / `ModelTokenUsage` | `packages/core/models/usage.ts` |
| Context window tracking | `ContextTracker` | `packages/core/models/context.ts` |
| Timing stats | `TimingStats` | `packages/core/models/timing.ts` |

### Adapt (Different Implementation, Same Concept)

| Concept | CC-Insights Approach | autonomOS Approach |
|---------|---------------------|-------------------|
| Session spawning | In-process `CliProcess` | Session broker service (can run remote) |
| Permission handling | Flutter dialog | Web modal + WebSocket callback |
| Persistence | JSONL files + JSON | SQLite (like MC) + optional JSONL export |
| State management | Provider + ChangeNotifier | Zustand slices (learn from MC's mistake) |
| Analytics dashboard | Table drill-down | Recharts time-series + table detail |
| Ticket management | Built-in system | Integrate with wt-plan workflow + optional external (GitHub Issues) |

### Build New (Not in CC-Insights)

| Feature | Why Needed | Priority |
|---------|-----------|----------|
| External session discovery | Scan `~/.claude/projects/` for sessions not spawned by autonomOS | HIGH |
| REST API | External tools need to query session state | HIGH |
| WebSocket server | Web dashboard needs real-time events | HIGH |
| Cross-project dashboard | "How much did all projects cost this week?" | HIGH |
| Time-series analytics | Cost over time, sessions per day, trends | MEDIUM |
| Multi-agent orchestration | Coordinate agents across sessions | MEDIUM |
| wt-plan integration | Import existing plan/worktree workflow | MEDIUM |
| GitHub PR correlation | Link sessions to PRs/branches/issues | MEDIUM |
| Agent provider adapters | Support Claude CLI, Codex, OpenClaw, custom | MEDIUM |

## 4. Integration Strategy

### Phase 1: Session Broker (Core)

Build a session broker that combines both approaches:

```
                     autonomOS Session Broker
                    +-------------------------+
                    |                         |
  Spawn path:      | EventTransport          |     Discover path:
  (CC-Insights      | (WebSocket impl)        |     (MC approach)
   pattern)         |                         |
                    | +-----+    +----------+ |
  Web Dashboard <-->| | WS  |    | Scanner  | |<-- ~/.claude/projects/
                    | +-----+    +----------+ |
                    |                         |
                    | +-----+    +----------+ |
  REST clients  <-->| | API |    | DB       | |<-- SQLite (session index)
                    | +-----+    +----------+ |
                    +-----+-------------------+
                          |
                    +-----v-------------------+
                    | Claude CLI subprocess   |
                    | (stream-json protocol)  |
                    +-------------------------+
```

### Phase 2: Dashboard (UI)

Web dashboard consuming the broker's API:

1. **Session list** -- all sessions (spawned + discovered), status, cost
2. **Session detail** -- conversation view with streaming (port CC-Insights' conversation panel to web)
3. **Permission handling** -- approve/deny from web (via WebSocket transport)
4. **Project stats** -- cross-project cost aggregation with Recharts
5. **Task integration** -- link sessions to wt-plan tasks

### Phase 3: Orchestration

Multi-agent coordination beyond what CC-Insights does:

1. **Agent fleet view** -- all agents across all sessions
2. **Task delegation** -- assign tasks to agents from dashboard
3. **Cost budgets** -- set spending limits per project/task
4. **Scheduling** -- cron-triggered agent sessions

## 5. Data Model Mapping

| CC-Insights Concept | autonomOS Equivalent | Notes |
|--------------------|---------------------|-------|
| `ProjectState` | `Project` (DB table) | Add cross-project queries |
| `WorktreeState` | `Worktree` (DB table) | Link to wt-plan features |
| `Chat` | `Session` (DB table) | Rename for clarity |
| `ConversationData` | `Conversation` (DB table) | Primary + subagent |
| `OutputEntry` | `Message` (DB table) | Sealed hierarchy -> discriminated union |
| `UsageInfo` | `TokenUsage` (DB table) | Per-turn granularity |
| `ModelUsageInfo` | `ModelUsage` (DB table) | Per-model within turn |
| `TimingStats` | `SessionTiming` (DB table) | Working vs response time |
| `ContextTracker` | `ContextState` (in-memory) | Live only, not persisted |
| `Ticket` | `Task` (integrate with wt-plan) | Don't rebuild, integrate |

## 6. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| GPLv3 contamination | HIGH | Study patterns only, reimplement from scratch in TypeScript. No code copying. |
| CLI protocol instability | MEDIUM | Claude CLI's stream-json format is undocumented; changes could break. Pin CLI version, add protocol negotiation. |
| Dart-only type definitions | LOW | Redefine in TypeScript with Zod validation. Consider JSON Schema as source of truth. |
| Desktop-to-web translation | MEDIUM | Permission dialogs need WebSocket round-trip. Latency could affect UX. |
| Session subprocess management | MEDIUM | Web server managing CLI subprocesses needs proper cleanup (SIGTERM on disconnect, zombie prevention). |

## 7. Key Takeaway

CC-Insights proves that **full interactive control of Claude Code sessions** is achievable and practical. Its `EventTransport` abstraction and `InsightsEvent` type system are the right patterns for this problem. The main gap is that it's a desktop app with no API surface.

autonomOS should:
1. **Reimplement the transport pattern** as a WebSocket-based session broker
2. **Combine spawning (CC-Insights) with scanning (MC)** for complete session visibility
3. **Add the analytics layer** that neither CC-Insights nor MC properly handles (time-series, cross-project, cost budgets)
4. **Integrate with the existing wt-plan workflow** instead of building another ticket system
