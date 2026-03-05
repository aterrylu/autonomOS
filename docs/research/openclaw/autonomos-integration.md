# autonomOS + OpenClaw Integration Analysis

> This is the most important deliverable of the OpenClaw research. It maps OpenClaw's architecture to autonomOS's needs and defines the concrete integration strategy.

## 1. Data Model Mapping

How do OpenClaw concepts map to autonomOS abstractions?

### Concept Alignment

| autonomOS Concept | OpenClaw Equivalent | Alignment | Notes |
|------------------|--------------------|-----------|----- |
| **Agent** | Agent (config + workspace) | Partial | OpenClaw agents are config entries with a workspace. autonomOS needs richer modeling: capabilities, health, runtime identity. |
| **Session** | SessionEntry (sessions.json) | Strong | OpenClaw sessions track sender, model, tokens, channel. Good fit for our session abstraction. |
| **Memory** | Memory files + vector DB | Strong | Per-agent memory with hybrid search. Matches our needs exactly. |
| **Task** | N/A | Gap | OpenClaw has no task/work-item concept. Mission Control adds this as a layer. |
| **Schedule** | CronJob (cron.json) | Strong | Clean job model with execution logging. Direct mapping. |
| **Channel** | Channel plugin (22+) | Strong | Messaging platform integrations. autonomOS just observes these. |
| **Tool** | AnyAgentTool (plugin SDK) | Strong | TypeBox-typed tools with execute handlers. Well-defined. |
| **Skill** | Skills (skills/) | Moderate | Bundled knowledge modules. Overlaps with our "capability" concept. |
| **Provider** | Provider plugin | Strong | LLM provider abstraction. Maps to our model routing. |
| **Device/Node** | Node (node registry) | Strong | Connected devices (iOS, Android, macOS). Maps to our robot path. |
| **Workflow** | N/A | Gap | OpenClaw has no multi-step workflow concept. Single agent turns only. |
| **Team/Fleet** | N/A | Gap | No multi-agent orchestration. Each agent is independent. |

### Key Divergences

1. **Agent Identity**: OpenClaw agents are lightweight config entries. autonomOS needs a richer `Agent` type with capabilities, health checks, persistent identity across sessions, and runtime metadata.

2. **Task Management**: OpenClaw has no concept of tasks/work items. This is a core autonomOS feature that sits entirely in our layer.

3. **Multi-Agent Orchestration**: OpenClaw runs each agent independently. Coordinating multiple agents working together is an autonomOS responsibility.

4. **Historical Analytics**: OpenClaw tracks current session usage but doesn't persist historical aggregates. autonomOS needs its own time-series store.

---

## 2. Observability Surface

What data can autonomOS read from OpenClaw **without modifying it**?

### Data Available via Gateway RPC

| Data Point | Gateway Method | Format | Update Frequency |
|-----------|---------------|--------|-----------------|
| Active sessions | `sessions:list` | JSON array of SessionEntry | On-demand |
| Session transcript | `sessions:preview` | Text | On-demand |
| Token usage (per-session) | `sessions:usage` | { input, output, cache } | On-demand |
| Agent list | `agents:list` | JSON array | On-demand |
| Agent identity | `agent:identity` | { name, theme, emoji } | On-demand |
| Agent workspace files | `agents:files:list/get` | File listing + content | On-demand |
| Channel health | `channels:status` | Status per channel | On-demand |
| Cron jobs | `cron:list` | JSON array of CronJob | On-demand |
| Cron run history | `cron:runs` | JSONL entries | On-demand |
| Cron scheduler status | `cron:status` | Status object | On-demand |
| Model catalog | `models:list` | Model definitions | On-demand |
| Connected devices | `node:list` | Node list | On-demand |
| Device details | `node:describe` | Device metadata | On-demand |
| Gateway health | `health` | Health status | On-demand |
| Gateway status | `status` | Status object | On-demand |
| Gateway logs | `logs:tail` | Log stream | Real-time |
| Config | `config:get` | Full config object | On-demand |
| Config schema | `config:schema` | JSON Schema | On-demand |

### Data Available via WebSocket Events (Real-Time)

| Event | Data | When |
|-------|------|------|
| Agent streaming text | Partial text chunks | During agent turns |
| Tool call details | Tool name, params, result | During agent turns |
| Chat message complete | Full message | After agent turn |
| Agent status change | New status | When agent starts/stops |

### Data Available via File System (Direct Read)

| File | Data | Format |
|------|------|--------|
| `~/.openclaw/sessions.json` | All session metadata | JSON |
| `~/.openclaw/cron.json` | All cron jobs | JSON |
| `~/.openclaw/cron/runs/*.jsonl` | Cron execution logs | JSONL |
| `~/.openclaw/openclaw.json` | Full configuration | JSON5 |
| `~/.openclaw/models.json` | Model definitions | JSON |
| `~/.openclaw/workspace/memory/*.md` | Agent memory files | Markdown |
| `~/.openclaw/logs/commands.log` | Command audit trail | JSONL |

### Observability Gaps

| Data Point | Status | Workaround |
|-----------|--------|-----------|
| Aggregate token usage (total, per-model, per-day) | Not available | Plugin hook on `agent_end` |
| Memory search results | Internal API only | Plugin with `registerGatewayMethod` |
| Agent decision traces | Streams but not persisted | Plugin hook on `after_tool_call` |
| Session start/end events | No webhook/event | Plugin hooks |
| Historical usage trends | No persistence | autonomOS DB + plugin |

---

## 3. Control Surface

What can autonomOS **control** in OpenClaw?

### Full Control Available

| Action | Method | Risk Level |
|--------|--------|-----------|
| Send message to agent | `chat:send` | Low |
| Abort running agent | `chat:abort` | Medium |
| Reset session | `sessions:reset` | Medium |
| Delete session | `sessions:delete` | High |
| Change session model | `sessions:patch` | Low |
| Compact session | `sessions:compact` | Low |
| Create cron job | `cron:add` | Low |
| Edit cron job | `cron:update` | Low |
| Delete cron job | `cron:remove` | Medium |
| Trigger cron job | `cron:run` | Medium |
| Create agent | `agents:create` | Low |
| Update agent config | `agents:update` | Medium |
| Delete agent | `agents:delete` | High |
| Edit agent files | `agents:files:set` | Medium |
| Edit global config | `config:set/patch` | High |
| Apply config changes | `config:apply` | High |
| Approve device pairing | `device:pair:approve` | Medium |
| Disconnect channel | `channels:logout` | High |

### Control Gaps

| Action | Status | Workaround |
|--------|--------|-----------|
| Start/stop individual agents | Not directly supported | Start via `chat:send`, stop via `chat:abort` |
| Pause/resume scheduling | Per-job disable via `cron:update` | Set `state.enabled: false` |
| Multi-agent orchestration | Not supported | autonomOS layer |
| Memory CRUD (add/edit/delete entries) | File-level only (`agents:files:set`) | Write markdown files |
| Rollback config changes | No versioning | autonomOS tracks versions |

---

## 4. Extension Strategy

If the existing APIs aren't enough, what's the cleanest way to extend?

### Option A: OpenClaw Plugin (RECOMMENDED)

**Effort:** 200-500 lines per feature
**Complexity:** Low
**Maintenance:** Must update with OpenClaw releases

Write an `autonomos` OpenClaw plugin that runs inside the gateway process:

```typescript
// extensions/autonomos/index.ts
export default {
  id: "autonomos",
  name: "autonomOS Integration",
  register(api: OpenClawPluginApi) {
    // 1. Expose memory search via gateway RPC
    api.registerGatewayMethod("autonomos:memory:search", async (params) => {
      return await searchMemory(params.query);
    });

    // 2. Track token usage aggregates
    api.on("agent_end", async (event) => {
      await recordUsage(event.usage, event.model, event.sessionKey);
    });

    // 3. Expose custom HTTP endpoint for dashboard
    api.registerHttpRoute({
      method: "GET",
      path: "/autonomos/metrics",
      handler: async (req, res) => {
        res.json(await getAggregateMetrics());
      },
    });

    // 4. Observe agent lifecycle
    api.on("message_received", (event) => {
      broadcastToAutonomOS("agent.message.received", event);
    });
    api.on("agent_end", (event) => {
      broadcastToAutonomOS("agent.turn.complete", event);
    });
  },
};
```

**Advantages:**
- Runs inside the gateway process — full access to runtime
- No forking, no external dependencies
- Clean upgrade path (plugin API is stable)
- Can register gateway methods, HTTP routes, hooks, tools

**Disadvantages:**
- Coupled to OpenClaw's plugin API version
- Runs in OpenClaw's process (resource sharing)
- Must distribute with OpenClaw or install separately

### Option B: Sidecar Process (WebSocket Client)

**Effort:** 500-1000 lines
**Complexity:** Medium
**Maintenance:** Low (protocol is stable)

Run autonomOS as a separate process that connects to the gateway as a WebSocket client:

```
autonomOS Process            OpenClaw Gateway
     │                            │
     │◄── WebSocket events ──────│  (real-time stream)
     │                            │
     │── RPC requests ──────────▶│  (sessions:list, etc.)
     │◄── RPC responses ─────────│
     │                            │
     │── File reads ─────────────▶ ~/.openclaw/  (direct FS access)
```

**Advantages:**
- Process isolation (doesn't affect OpenClaw stability)
- Works with any OpenClaw version that speaks WS protocol v3
- Can run on a different machine (if remote gateway configured)

**Disadvantages:**
- Can't access internal APIs (memory search, etc.)
- Higher latency than in-process plugin
- Must handle reconnection, auth, heartbeat

### Option C: Fork OpenClaw

**Effort:** High (ongoing maintenance)
**Complexity:** High
**Maintenance:** Must merge upstream changes

**NOT recommended** unless OpenClaw's architecture fundamentally doesn't fit. MIT license allows it, but the maintenance burden is high.

### Recommended Strategy

**Hybrid: Plugin + Sidecar**

1. **Phase 1 (Now):** Sidecar — Connect to gateway as WebSocket client. Use existing RPC methods for observability. No OpenClaw modification needed.

2. **Phase 2 (When gaps appear):** Plugin — Write an `autonomos` OpenClaw plugin for features the sidecar can't do (memory search, token aggregation, custom events).

3. **Phase 3 (If needed):** Both — Plugin exposes internal data via custom gateway methods, sidecar consumes them alongside standard methods.

---

## 5. Mission Control Reference

[builderz-labs/mission-control](https://github.com/builderz-labs/mission-control) already solved the "dashboard for OpenClaw" problem. Key patterns to learn from:

### What MC Does That We Should Do

| MC Feature | How They Do It | Our Approach |
|-----------|---------------|-------------|
| Session tracking | WebSocket to gateway + SQLite cache | WebSocket + our DB |
| Token cost tracking | Parse session usage, estimate per-model | Same, plus aggregation |
| Cron management | Gateway RPC | Same |
| Real-time updates | SSE event bus + gateway WebSocket | Same (SSE to our frontend) |
| Agent status | Heartbeat timeout detection | Same, plus richer health model |
| Claude Code sessions | Scan `~/.claude/projects/` JSONL | Port their scanner |

### Where We Diverge from MC

| Aspect | Mission Control | autonomOS |
|--------|-----------------|-----------|
| **Scope** | OpenClaw-only | Agent-agnostic (OpenClaw is one provider) |
| **Architecture** | Monolithic Next.js | `packages/core` + `packages/dashboard` |
| **Agent model** | DB row with name/status | Rich abstraction with capabilities, health, identity |
| **State management** | Single 760-line Zustand store | Sliced by feature |
| **Routing** | Switch statement, no URLs | URL-based App Router |
| **Robot support** | None | Future path via topics/sensors |
| **Multi-agent** | No orchestration | Core feature |

### MC's Gateway Connection Code

MC connects to OpenClaw via the same WebSocket protocol we'd use. Their `lib/websocket.ts` is a reference implementation:

1. Connect with protocol v3 handshake
2. Ping/pong heartbeat (30s interval, 3 missed = reconnect)
3. Exponential backoff reconnection (up to 10 attempts, max 30s)
4. Event dispatch: `tick:sessions`, `log:entry`, `chat.message`, `agent.status`

---

## 6. Concrete Integration Plan

### Phase 1: Read-Only Observability (NOW)

Build `packages/core/src/providers/openclaw.ts`:

```typescript
class OpenClawProvider implements AgentProvider {
  // Connect to gateway WebSocket
  async connect(url: string, auth?: AuthConfig): Promise<void>;

  // Read operations via gateway RPC
  async listSessions(): Promise<Session[]>;       // sessions:list
  async getSessionUsage(id: string): Promise<Usage>; // sessions:usage
  async listAgents(): Promise<Agent[]>;            // agents:list
  async listCronJobs(): Promise<CronJob[]>;        // cron:list
  async getCronRuns(jobId: string): Promise<Run[]>; // cron:runs
  async getChannelStatus(): Promise<ChannelStatus[]>; // channels:status
  async getHealth(): Promise<HealthStatus>;        // health

  // Real-time events
  onEvent(handler: (event: AgentEvent) => void): void;
}
```

### Phase 2: Control Operations (AFTER trust is established)

Add write methods to the provider:

```typescript
// Chat control
async sendMessage(sessionKey: string, text: string): Promise<void>;
async abortAgent(sessionKey: string): Promise<void>;
async resetSession(sessionKey: string): Promise<void>;

// Cron management
async createCronJob(job: CronJobConfig): Promise<string>;
async updateCronJob(id: string, patch: Partial<CronJobConfig>): Promise<void>;
async deleteCronJob(id: string): Promise<void>;
async triggerCronJob(id: string): Promise<void>;

// Config
async getConfig(): Promise<OpenClawConfig>;
async patchConfig(patch: Partial<OpenClawConfig>): Promise<void>;
```

### Phase 3: Deep Integration (WHEN NEEDED)

Write the `autonomos` OpenClaw plugin:

```typescript
// Plugin provides:
// - autonomos:metrics — aggregate token usage, trends
// - autonomos:memory:search — expose memory search
// - autonomos:events — structured event stream for dashboard
// - Hooks for agent lifecycle observation
```

---

## 7. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Gateway protocol changes | Low (v3 is stable) | High | Pin to protocol version, test on upgrades |
| Plugin API breaking changes | Low (SDK is public) | Medium | Pin plugin SDK version |
| Gateway not running | Medium | High | Graceful degradation (local mode, like MC) |
| Auth changes | Low | Medium | Support both token + password auth |
| Performance impact of WS client | Low | Low | Minimal overhead (just RPC calls) |
| OpenClaw project abandoned | Very Low | High | MIT license allows forking |

---

## 8. Summary: What autonomOS Gets from OpenClaw

### For Free (Existing APIs)

- Session list, preview, usage, reset
- Agent list, create, update, delete
- Cron CRUD + manual trigger + run history
- Channel health monitoring
- Config read/write
- Model catalog
- Device/node management
- Real-time agent streaming events
- Gateway health + logs

### Needs a Plugin (~500 lines)

- Aggregate token usage metrics
- Memory search from dashboard
- Agent lifecycle event webhooks
- Custom metrics endpoint

### Needs autonomOS's Own Layer

- Task/work-item management
- Multi-agent orchestration
- Historical analytics (time-series)
- Claude Code session tracking (port from MC)
- Rich agent modeling (capabilities, health)
- Provider abstraction (OpenClaw is one of many)
- Dashboard UI

### The Core Insight

OpenClaw is an excellent **agent runtime** — it handles sessions, memory, scheduling, tool execution, and multi-channel routing. But it's not a **control plane** — it has no dashboard, no aggregate analytics, no multi-agent orchestration, no task management. That's exactly the gap autonomOS fills.

The integration is clean: WebSocket client for observability + control, optional plugin for deep integration, autonomOS's own DB for aggregation and features OpenClaw doesn't have. No forking needed.
