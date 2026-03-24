# Jinn

**By:** Hristo Georgiev (hristo2612)
**License:** MIT
**Language:** TypeScript (Node.js)
**Repo:** https://github.com/hristo2612/jinn
**Stars:** ~500 (niche/personal project)

---

## What It Is

Jinn is a personal agent management daemon that spawns and manages Claude Code sessions as child processes. The headline feature: it runs on `$200/mo Claude Max` — no API key needed, no per-token billing. Jinn is a gateway that makes Claude Code's CLI (`claude -p --resume`) addressable over HTTP/WebSocket.

**Core philosophy: "bus not brain."** Jinn doesn't try to coordinate agents intelligently — it's a message bus. Agents define their own behavior via YAML + CLAUDE.md. The platform just delivers messages.

---

## Architecture

```
┌─────────────────────────────────┐
│  Next.js Dashboard              │
│  (view sessions, send msgs)     │
└────────────┬────────────────────┘
             │ HTTP / WebSocket
┌────────────▼────────────────────┐
│  Jinn Gateway Daemon            │
│  (Node.js HTTP server)          │
│                                 │
│  ┌──────────┐  ┌──────────────┐ │
│  │ SQLite   │  │ Agent Config │ │
│  │ sessions │  │ Loader       │ │
│  └──────────┘  └──────────────┘ │
└─────┬───────────────────────────┘
      │ spawns child processes
      ▼
claude -p --resume <session-id>
```

### Key Mechanisms

**Session spawning:**
```bash
claude -p --resume <session-uuid> "Your message here"
```
Jinn calls this as a child process. `--resume` continues an existing Claude Code session by UUID. `--print` (`-p`) outputs to stdout and exits. This is the trick that makes Claude Max usable for agents.

**MCP gateway pattern:**
Each Jinn agent instance exposes itself as an MCP server. Other agents (or external tools) can call it via the MCP protocol. This creates a mesh where agents are both consumers and providers.

**Hot-reload:** File watcher via `chokidar` — drop/edit a YAML file in `~/.jinn/` and the agent reloads without restarting the daemon.

---

## Agent Definition

```yaml
# ~/.jinn/org/engineering/code-reviewer.yaml
name: Code Reviewer
department: engineering
model: claude-opus  # or haiku, sonnet
description: Reviews PRs and suggests improvements

schedule:
  cron: "0 * * * *"   # hourly

permissions:
  tools:
    - Read
    - Bash

mcp:
  expose: true          # makes this agent callable as MCP tool
  port: 3001
```

Agent identity/behavior defined in CLAUDE.md adjacent to the YAML.

**Directory structure:**
```
~/.jinn/
├── org/
│   ├── engineering/
│   │   ├── code-reviewer.yaml
│   │   └── code-reviewer.CLAUDE.md
│   └── home/
│       ├── presence.yaml
│       └── presence.CLAUDE.md
└── sessions.db   # SQLite, stores session UUIDs + metadata
```

---

## Session Management

- Sessions stored in SQLite: `{ session_uuid, agent_name, created_at, last_message_at, status }`
- `claude -p --resume <uuid>` rehydrates Claude's internal conversation state from disk (Claude Code caches sessions in `~/.claude/projects/`)
- No explicit conversation history management — Claude Code handles it
- **Rate limit fallback:** If Claude hits a rate limit, Jinn can optionally fall back to OpenAI Codex (configurable per-agent). Pragmatic engineering for Max tier limits.

---

## Dashboard

Next.js app (separate from daemon). Features:
- List all agents and their current status
- Send messages to any agent session
- View conversation history
- Real-time updates via WebSocket
- No auth (personal tool)

---

## What Makes It Interesting

1. **Claude Max as infrastructure** — entirely avoids API billing. `claude -p --resume` is the unlock. Most other tools assume API access.

2. **MCP mesh** — agents exposing themselves as MCP servers is clever. It's a peer-to-peer capability sharing model without a central registry.

3. **Minimal orchestration surface** — the daemon doesn't make decisions. It routes. This keeps bugs shallow and behavior predictable.

4. **chokidar hot-reload** — operator experience first-class. Drop a YAML file, agent is live. No restart required.

---

## Weaknesses

- **Claude Code dependency** — `claude -p --resume` is undocumented CLI behavior. Could break with any Claude Code update.
- **No persistent session for scheduled tasks** — each cron tick spawns a new `claude -p` invocation. Resume works but full history may hit context limits over time.
- **SQLite single-node** — fine for personal use, not scalable.
- **No inter-agent coordination** — "bus not brain" means no orchestration. Multi-step workflows require external logic.
- **Fragile process management** — child process model has edge cases (zombie processes, crash recovery).

---

## Relevance to autonomOS

| Concept | Jinn | autonomOS |
|---------|------|-----------|
| Session spawning | `claude -p --resume` (child process) | Claude Agent SDK `query()` |
| Agent definition | YAML + adjacent CLAUDE.md | `agent.yaml` + `.claude/CLAUDE.md` |
| Session persistence | SQLite (session UUIDs) | `state/` folder per agent |
| Scheduling | Cron in YAML | Cron in `agent.yaml` |
| Inter-agent comms | MCP mesh | Punted to roadmap |
| Billing | Claude Max ($200/mo flat) | API key |
| Dashboard | Next.js | React in `packages/dashboard/` |

### Key borrowings

- **`claude -p --resume` as an option** — Jinn's discovery is valid. autonomOS could offer this as an alternative backend to the Agent SDK for users with Claude Max. Lower cost for high-volume agents.
- **MCP mesh pattern** — worth keeping as a design input for inter-agent communication when we get there. Agents as MCP servers is an elegant peer model.
- **YAML + CLAUDE.md co-location** — Jinn validates the "YAML for schedule/meta, CLAUDE.md for identity" split we already landed on.
- **Hot-reload via file watcher** — autonomOS server should watch `~/.autonomos/agents/` for changes.
