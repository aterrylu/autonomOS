# Agent Platform Design

Research from design session on 2026-03-17. Covers the architecture for autonomOS's
agent platform — how agents are defined, scheduled, and run using the Claude Agent SDK.

---

## Core Mental Model

**Agent = definition (config folder). Session = running instance.**

This is OpenClaw's model, adopted directly. An agent is not a process — it's a folder
with a CLAUDE.md, skills, and settings. Sessions are what actually run. Multiple sessions
can share one agent definition simultaneously, each with their own conversation history.

Analogy: an agent folder is like a `.claude/` directory. Just as multiple Claude Code
instances can run in the same repo sharing the same `.claude/` folder, multiple sessions
can run from the same agent folder sharing its config.

---

## Folder Structure

```
~/.autonomos/
├── CLAUDE.md                            # base context loaded by ALL agents
│                                        # (what autonomOS is, state/ protocol,
│                                        #  inter-agent conventions)
├── OWNER.md                             # owner profile (Terry), injected for all agents
└── agents/
    └── home-presence/
        ├── agent.json                   # schedule, model, display metadata (autonomOS runner config)
        ├── state/                       # shared across all sessions of this agent
        └── .claude/
            ├── CLAUDE.md               # agent-specific behavior only
            ├── settings.json           # allowed tools, permissions, hooks, MCP servers
            └── skills/
                └── analyze-camera/
                    └── SKILL.md
```

All agents are flat peers under `agents/`. No hierarchy, no templates folder, no
singleton/multi/job split. Simplicity > cleverness for v1.

---

## agent.json Schema

```json
{
  "name": "Home Presence",
  "description": "Monitors cameras and presence",
  "model": "sonnet",
  "schedule": {
    "cron": "*/5 * * * *",
    "mode": "oneshot"
  }
}
```

Deliberately minimal. `agent.json` owns **when** the agent runs and **what model** it uses
(autonomOS runner concerns). Everything else — allowed tools, permissions, hooks, MCP
servers — lives in `.claude/settings.json` where Claude Code already handles it.

No duplication. No `allowedTools` in agent.json. The runner reads `agent.json`; the SDK reads `.claude/`.

---

## Sessions — OpenClaw Model

Borrowed directly from OpenClaw's session design:

| Concept | Description |
|---|---|
| Session | Per-trigger or per-user conversation instance |
| `oneshot` | Fresh isolated session per cron tick. Cheap, stateless, no context bloat |
| `persistent` | One long-lived session. Cron sends messages INTO it instead of spawning new |
| `state/` | Shared per-agent storage. All sessions read/write here. The continuity layer |

### oneshot (default)

```
Tick 1: spawn session → read state/ → do work → write state/ → session dies
Tick 2: spawn session → read state/ → do work → write state/ → session dies
```

Each run is cheap. Agent "remembers" via `state/` files, not via conversation history.
No context window growth over time. Maps directly to OpenClaw's `sessionTarget: "isolated"`.

### persistent

One long-lived session. The cron tick sends a message into it:
```
"It's been 5 minutes. Check cameras again."
```
Agent retains full conversation history across ticks. More expensive, context accumulates.
Use when conversational continuity genuinely matters. Requires a context compaction/archival
strategy for long-running agents. Maps to OpenClaw's `sessionTarget: "main"`.

### When to use which

| Mode | Use when |
|---|---|
| `oneshot` | Monitoring, scheduled tasks, anything where state/ is sufficient memory |
| `persistent` | Interactive agents, cases where multi-turn reasoning across ticks matters |

Default to `oneshot`. Use `persistent` only with a specific reason.

---

## Context Assembly — Two Separate Mechanisms

The key insight: **CLAUDE.md and skills/settings are loaded via different mechanisms, intentionally.**

### CLAUDE.md — assembled explicitly by the runner

Do NOT rely on the SDK's parent-directory walk for CLAUDE.md inheritance. It works, but
it's implicit, fragile (breaks if you move folders), and couples agent location to config
inheritance. The SDK may also change this behavior since parent-dir walking is a side
effect of `settingSources`, not a primary documented feature.

Instead, the autonomOS agent runner explicitly assembles the system prompt:

```typescript
const baseContext = readFile("~/.autonomos/CLAUDE.md")
const agentContext = readFile(`agents/${name}/.claude/CLAUDE.md`)

query({
  prompt: triggerMessage,
  options: {
    systemPrompt: `${baseContext}\n\n---\n\n${agentContext}`,
    cwd: agentFolder,
    settingSources: ["project"],    // loads skills + settings.json, NOT CLAUDE.md
  }
})
```

`systemPrompt` is a direct injection parameter in `query()`. It bypasses filesystem
loading entirely. You control composition order, can log/debug the full context, and
the behavior is stable regardless of where agent folders live.

### Skills + settings.json — loaded by settingSources

`settingSources: ["project"]` loads skills and `settings.json` from the agent's
`.claude/` folder. This IS the right mechanism — they're agent-owned config that
belongs in the filesystem and changes less often than per-run context.

### The layers an agent sees

```
┌─────────────────────────────────────────────┐
│  systemPrompt (assembled by runner)         │
│    ~/.autonomos/CLAUDE.md  (base context)   │
│    agent's .claude/CLAUDE.md (agent-specific│
├─────────────────────────────────────────────┤
│  settingSources: ["project"]                │
│    skills from .claude/skills/              │
│    permissions from .claude/settings.json   │
├─────────────────────────────────────────────┤
│  prompt (the trigger message / user msg)    │
└─────────────────────────────────────────────┘
```

### Shared skills — open question

Skills shared across all agents ideally live at `~/.autonomos/.claude/skills/`.
`settingSources: ["user"]` would load them but conflicts with the user's personal
`~/.claude/` settings. Options:
1. Inject shared skill content via `systemPrompt` in the runner
2. Dedicated MCP server exposing shared capabilities
3. Runner passes a custom `settingSources`-equivalent pointing at `~/.autonomos/.claude/`

Decision pending — needs more investigation into what "shared skills" actually covers.

---

## AgentRuntime Abstraction

autonomOS should NOT couple its scheduler/runner directly to `@anthropic-ai/claude-agent-sdk`.
The goal is to eventually build a custom SDK — the runtime abstraction is the seam that
makes that swap possible without changing the scheduler, dashboard, or agent definitions.

```typescript
interface AgentRuntime {
  startSession(config: AgentConfig): Session
  sendMessage(sessionId: string, message: string): AsyncIterable<Event>
  stopSession(sessionId: string): void
}
```

Today: `AnthropicRuntime` implements this via `query()` from the Agent SDK.
Future: `CustomRuntime` implements the same interface with autonomOS's own SDK.

This extends the existing `AgentProvider` pattern in `packages/core/src/types/provider.ts`
to a higher level of abstraction.

---

## What OpenClaw Does vs What We Do

Understanding the delta helps when diverging:

| | OpenClaw | autonomOS |
|---|---|---|
| Agent config | Entry in `openclaw.json` | Folder with CLAUDE.md + agent.json |
| System prompt | Built programmatically in code | Assembled from files by runner |
| Skills | Bundled in agent config | Loaded from `.claude/skills/` by SDK |
| Shared memory | Vector DB (per-agent, sqlite-vec) | `state/` folder (per-agent) |
| Cron sessions | `sessionTarget: isolated/main` | `mode: oneshot/persistent` |
| Inter-agent comms | Not supported | Punted — roadmap item |
| Config format | Monolithic `openclaw.json` | One folder per agent (composable) |

OpenClaw's monolithic config: adding an agent = editing a central file.
autonomOS's folder model: adding an agent = dropping a folder.
More composable, easier to version control individual agents, easier to publish/share.

---

## Open Questions

1. **Shared skills mechanism** — how to load skills shared across all agents without
   conflicting with the user's personal `~/.claude/` settings.

2. **Persistent session continuation via SDK** — does `query()` support resuming a
   session by ID, or do we need to manage conversation history ourselves (store
   transcript, pass it back in on next call)?

3. **Context window management for persistent agents** — compaction strategy for
   long-running agents. OpenClaw compacts on overflow; we need an equivalent.

4. **Built-in autonomOS agents** — coordinator agent that ships with autonomOS.
   Likely lives in `packages/agents/` in the repo and is installed to
   `~/.autonomos/agents/` on first run.

5. **Dashboard: agents vs sessions** — "session" is too technical. Current thinking:
   everything user-facing is called "agent." A running session shows under its
   agent definition. TBD on exact UI shape.

---

## Punted to Roadmap

- Inter-agent communication (agents addressing each other by name)
- Context-scoped sessions (OpenClaw's channel model — same agent, different channel = different session)
- Template system for multi-instance agents (copy folder for now)
- Event-based triggers (USB device connected, etc.) — use fast cron polling for v1
- Agent-to-agent discovery across autonomOS instances (multi-machine federation)
