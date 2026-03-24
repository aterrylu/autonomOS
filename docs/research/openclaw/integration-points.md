# OpenClaw — Integration Points for autonomOS

## Overview

This document maps every API, CLI command, event, and hook that autonomOS can use to observe and control OpenClaw agents. Split into two sections: **what we can build today** (using existing APIs) and **what needs extension work** (requires a custom plugin or feature request).

## 1. Gateway WebSocket RPC Methods

The gateway exposes 50+ RPC methods via WebSocket. These are the primary programmatic interface.

### Session Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `sessions:list` | Read | List all stored sessions | Dashboard: show active/recent sessions |
| `sessions:preview` | Read | Get session transcript preview | Dashboard: session inspector |
| `sessions:resolve` | Read | Resolve session key to entry | Lookup session by sender |
| `sessions:usage` | Read | Get token usage for sessions | Cost tracking |
| `sessions:patch` | Write | Modify session metadata | Change model, thinking level |
| `sessions:reset` | Write | Reset a session | Control: force session reset |
| `sessions:delete` | Write | Delete a session | Cleanup |
| `sessions:compact` | Write | Compact session transcript | Free up context window |
| `sessions:send` | Write | Send message from one agent to another | Inter-agent communication (A2A) |

### Agent Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `agent` | Write | Run one agent turn | Trigger agent execution |
| `agent:identity` | Read | Get agent identity info | Dashboard: agent card |
| `agent:wait` | Read | Wait for agent run to complete | Synchronous agent calls |
| `agents:list` | Read | List all configured agents | Dashboard: agent registry |
| `agents:create` | Write | Create a new agent | Control: provision agents |
| `agents:update` | Write | Update agent config | Control: modify agents |
| `agents:delete` | Write | Remove an agent | Control: decommission |
| `agents:files:list` | Read | List agent workspace files | File browser |
| `agents:files:get` | Read | Read an agent workspace file | Memory/config viewer |
| `agents:files:set` | Write | Write an agent workspace file | Memory/config editor |

### Agent-to-Agent (A2A) Tools

OpenClaw has **native inter-agent communication** via two agent-facing tools:

| Tool | What It Does | Notes |
|------|-------------|-------|
| `sessions_send` | Agent A sends a message to Agent B | Ping-pong reply flow, up to `maxPingPongTurns` (default 5) |
| `sessions_spawn` | Agent A spawns a sub-agent for task delegation | Isolated session; result returned to caller |

**Configuration** (`openclaw.json`):

```json
{
  "tools": {
    "agentToAgent": {
      "enabled": true,
      "allow": ["agent-a", "agent-b"],
      "maxPingPongTurns": 5
    },
    "sessions": {
      "visibility": "tree"
    }
  }
}
```

- `tools.agentToAgent.enabled` — disabled by default; must be explicitly enabled
- `tools.agentToAgent.allow` — optional allowlist of agent IDs that may communicate
- `tools.agentToAgent.maxPingPongTurns` — caps back-and-forth turns (default 5)
- `tools.sessions.visibility` — controls which sessions an agent can see: `"tree"` (default, agent + descendants), `"self"`, `"agent"`, `"all"`

**Known bug:** Slack channel A2A routing is broken (GitHub issue #15946).

**Memory isolation:** Memory remains siloed per agent — `sessions_send` enables message passing, not memory sharing. This is by design.

### Chat Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `chat:send` | Write | Send message to agent | Dashboard: chat panel |
| `chat:inject` | Write | Inject message into session | System messages |
| `chat:abort` | Write | Cancel running agent turn | Emergency stop |
| `chat:history` | Read | Get chat history | Dashboard: conversation view |

### Cron Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `cron:list` | Read | List all cron jobs | Dashboard: schedule view |
| `cron:add` | Write | Create a new cron job | Control: add schedules |
| `cron:update` | Write | Modify a cron job | Control: edit schedules |
| `cron:remove` | Write | Delete a cron job | Control: remove schedules |
| `cron:run` | Write | Manually trigger a job | Control: force run |
| `cron:runs` | Read | Get run history | Dashboard: run logs |
| `cron:status` | Read | Get scheduler status | Dashboard: scheduler health |

### Channel Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `channels:status` | Read | Get status of all channels | Dashboard: channel health |
| `channels:logout` | Write | Disconnect a channel | Control: channel management |

### Config Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `config:get` | Read | Get current config | Dashboard: config viewer |
| `config:set` | Write | Set config value | Control: config editor |
| `config:patch` | Write | Patch config (merge) | Control: partial updates |
| `config:apply` | Write | Apply config changes | Control: apply and reload |
| `config:schema` | Read | Get config JSON schema | Dashboard: form generation |

### Model Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `models:list` | Read | List available models | Dashboard: model catalog |

### Device/Node Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `node:list` | Read | List connected devices | Dashboard: device view |
| `node:describe` | Read | Get device details | Dashboard: device info |
| `node:invoke` | Write | Send command to device | Control: device actions |
| `device:pair:list` | Read | List pairing requests | Dashboard: pairing view |
| `device:pair:approve` | Write | Approve pairing | Control: accept device |

### System Methods

| Method | Type | What It Does | autonomOS Use |
|--------|------|-------------|---------------|
| `health` | Read | Gateway health check | Dashboard: health indicator |
| `status` | Read | Gateway status | Dashboard: system status |
| `system:events` | Read | Get queued events | Event monitoring |
| `system:heartbeat` | Write | Trigger heartbeat | Keep-alive |
| `system:presence` | Read | Get presence info | Online status |
| `logs:tail` | Read | Tail gateway logs | Dashboard: log viewer |

---

## 2. CLI Commands

The CLI can be invoked programmatically via Node.js `spawn`/`fork` or via the gateway RPC (preferred for most operations).

### Key Commands for autonomOS

```bash
# Sessions
openclaw sessions list           # List stored sessions
openclaw sessions preview <key>  # Preview session transcript

# Agents
openclaw agents list             # List configured agents
openclaw agent --message "..."   # Run one agent turn
openclaw status                  # Channel health + recent recipients
openclaw health                  # Gateway health check

# Cron
openclaw cron list               # List cron jobs
openclaw cron add                # Add a cron job
openclaw cron run <id>           # Manually trigger
openclaw cron logs <id>          # View run history

# Config
openclaw config get <key>        # Get config value
openclaw config set <key> <val>  # Set config value

# Memory
openclaw memory search <query>   # Search agent memory

# System
openclaw doctor                  # Health diagnostics
openclaw gateway run             # Start the gateway
```

---

## 3. WebSocket Events (Real-Time Stream)

Connected WebSocket clients receive live events:

| Event | Data | autonomOS Use |
|-------|------|---------------|
| Agent streaming text | Partial text chunks | Dashboard: live chat view |
| Tool call start/end | Tool name, params, result | Dashboard: tool activity |
| Chat message | Complete message | Dashboard: conversation feed |
| Agent status change | New status | Dashboard: agent status indicator |
| System notifications | Various | Dashboard: notification feed |

The gateway broadcasts events to all connected clients. autonomOS can connect as a client and consume these events for real-time UI updates.

---

## 4. Internal Hook System

### Bundled Hooks

| Hook | Event | What It Does | autonomOS Relevance |
|------|-------|-------------|-------------------|
| `session-memory` | `command:new`, `command:reset` | Saves session context to memory | Observe memory changes |
| `bootstrap-extra-files` | `agent:bootstrap` | Injects extra files into prompt | Understand agent context |
| `command-logger` | `command` (all) | Logs commands to JSONL | Audit trail |
| `boot-md` | `gateway:startup` | Runs BOOT.md on startup | Startup automation |

### Custom Hook Locations
- `~/.openclaw/hooks/` — global hooks
- `<workspace>/hooks/` — per-workspace hooks
- Plugin hooks via SDK

### Hook Structure
```
my-hook/
  HOOK.md           # Metadata (YAML frontmatter)
  handler.ts        # Handler function
```

Metadata fields: `events[]`, `requires.bins[]`, `requires.env[]`, `requires.os[]`

---

## 5. File System (Direct Read Access)

autonomOS can read OpenClaw's data files directly for observability:

| Path | Format | What It Contains |
|------|--------|-----------------|
| `~/.openclaw/openclaw.json` | JSON5 | Full configuration |
| `~/.openclaw/sessions.json` | JSON | All session metadata |
| `~/.openclaw/cron.json` | JSON | Cron job definitions |
| `~/.openclaw/cron/runs/*.jsonl` | JSONL | Cron run history |
| `~/.openclaw/models.json` | JSON | Model catalog |
| `~/.openclaw/workspace/memory/*.md` | Markdown | Agent memory files |
| `~/.openclaw/sessions/` | Internal | Session transcripts |
| `~/.openclaw/logs/` | Text/JSONL | Gateway logs |
| `~/.openclaw/credentials/` | JSON | API keys/tokens (SENSITIVE) |

---

## 6. HTTP Endpoints

The gateway HTTP server exposes:

| Endpoint | Purpose | Auth Required |
|----------|---------|--------------|
| Control UI | Static web app | Bearer token |
| Plugin routes | Plugin-registered endpoints | Varies |
| Webhook receivers | Inbound webhooks (Slack, Discord, etc.) | Per-channel |
| Canvas host (`/a2ui/`) | Canvas rendering | Optional |

---

## What We Can Build TODAY

Using only existing gateway RPC methods + file system reads:

### Observability Dashboard (Read-Only)

| Feature | Data Source | Confidence |
|---------|-----------|------------|
| Active sessions list | `sessions:list` | High |
| Session transcript preview | `sessions:preview` | High |
| Token usage per session | `sessions:usage` | High |
| Channel health status | `channels:status` | High |
| Cron job list + status | `cron:list`, `cron:status` | High |
| Cron run history | `cron:runs` | High |
| Model catalog | `models:list` | High |
| Agent list | `agents:list` | High |
| Gateway health | `health`, `status` | High |
| Live agent streaming | WebSocket events | High |
| Config viewer | `config:get`, `config:schema` | High |
| Agent memory files | `agents:files:list/get` or direct FS | High |
| Connected devices | `node:list`, `node:describe` | High |
| Gateway logs (tail) | `logs:tail` | High |

### Control Panel (Read-Write)

| Feature | Data Source | Confidence |
|---------|-----------|------------|
| Send message to agent | `chat:send` | High |
| Abort running agent | `chat:abort` | High |
| Reset session | `sessions:reset` | High |
| Create/edit/delete cron jobs | `cron:*` methods | High |
| Manually trigger cron job | `cron:run` | High |
| Edit config | `config:set/patch/apply` | High |
| Approve device pairing | `device:pair:approve` | High |
| Switch session model | `sessions:patch` | High |
| Create/update agents | `agents:create/update` | High |
| Edit agent memory files | `agents:files:set` | High |

---

## What NEEDS Extension Work

Features that require a custom OpenClaw plugin or upstream changes:

### Requires Plugin

| Feature | Why | Plugin Approach |
|---------|-----|-----------------|
| Token usage aggregation (total spend, per-model, per-day) | Gateway tracks per-session, no aggregate API | Plugin hook on `agent_end` to accumulate to DB |
| Memory search from dashboard | Memory search API is internal, not exposed via RPC | Plugin registers `registerGatewayMethod("memory:search", ...)` |
| Agent decision traces (why did it do X?) | Tool call details flow over WebSocket but aren't persisted queryably | Plugin hook on `after_tool_call` to log to queryable store |
| Webhook on cron completion | No event emitted when cron finishes | Plugin hook on `agent_end` + check if cron-triggered |
| Multi-agent coordination status | Native A2A (`sessions_send`) exists but no team/orchestration state concept | Plugin manages team state, registers status endpoint |
| Custom metrics endpoint | No Prometheus/OTEL export by default | Use `diagnostics-otel` extension or write custom |

### Requires Upstream Change

| Feature | Why | Effort |
|---------|-----|--------|
| Historical token usage query | No persistent aggregation store | Medium |
| Session duration tracking | No `startedAt` field on sessions | Low |
| Agent capability declaration | No formal capability model | Medium |

---

## Integration Architecture

### Recommended: Gateway WebSocket Client

```
  autonomOS Dashboard
         │
         │  Uses OpenClaw Provider
         │  (WebSocket client library)
         │
         │ WebSocket (ws://127.0.0.1:18789)
         ▼
  OpenClaw Gateway
  (existing process)
```

### Connection Protocol

```typescript
// 1. Connect
const ws = new WebSocket("ws://127.0.0.1:18789");

// 2. Handshake
ws.send(JSON.stringify({
  type: "req",
  id: "connect-1",
  method: "connect",
  params: {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "autonomos-dashboard",
      displayName: "autonomOS",
      version: "0.1.0",
      platform: process.platform,
      mode: "rpc",
    },
    auth: { token: "..." },  // If auth configured
    scopes: ["read", "write"],
  },
}));

// 3. Send RPC requests
ws.send(JSON.stringify({
  type: "req",
  id: "req-1",
  method: "sessions:list",
  params: {},
}));

// 4. Receive responses + events
ws.onmessage = (msg) => {
  const frame = JSON.parse(msg.data);
  if (frame.type === "res") handleResponse(frame);
  if (frame.type === "event") handleEvent(frame);
};
```

---

## Takeaway for autonomOS

### The Gateway is the Integration Hub

Every piece of data we need flows through the gateway WebSocket. Instead of scraping files or parsing CLI output, we connect as a WebSocket client and use RPC methods. This gives us:

1. **Real-time events** — streaming agent text, tool calls, status changes
2. **Full CRUD** — sessions, agents, cron, config, devices
3. **Schema-driven** — TypeBox schemas validate all payloads
4. **Auth-compatible** — same auth system as other clients

### What's Missing (Gaps)

1. **No aggregate token tracking** — per-session only, no "total spend this week"
2. **No memory search API** — internal only, needs plugin to expose
3. **No event export/webhook** — can't subscribe to events from outside the gateway
4. **No multi-agent orchestration state** — native A2A messaging exists (`sessions_send`, `sessions_spawn`) but no built-in concept of agent teams, task queues, or orchestration graphs
5. **No historical analytics** — no time-series data storage

All gaps can be filled with a custom OpenClaw plugin (~200-500 lines each), which is the recommended approach over forking or CLI scraping.
