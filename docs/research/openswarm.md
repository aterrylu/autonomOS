# OpenSwarm

**By:** Open source community
**License:** MIT
**Language:** TypeScript / Python (mixed)
**Repo:** https://github.com/openswarmproject/openswarm (or equivalent)
**Focus:** Multi-agent swarm with Discord control plane and cognitive memory

---

## What It Is

OpenSwarm is a multi-agent framework that uses **Discord as its control interface** and **LanceDB for cognitive memory**. The idea: Discord is already the interface for communities and teams — use it as the human-in-the-loop control layer. Agents post their outputs to Discord channels; humans approve or redirect via Discord reactions/commands.

---

## Architecture

```
Human (Discord)
    │ messages / reactions
    ▼
┌───────────────────────────────────────┐
│  Discord Bot (control plane)          │
│  - routes commands to agents          │
│  - posts agent outputs to channels    │
└──────────┬────────────────────────────┘
           │
    ┌──────▼──────┐    ┌─────────────────┐
    │  Agent Pool │    │  LanceDB        │
    │  (workers)  │◄──►│  (cognitive     │
    └─────────────┘    │   memory)       │
                       └─────────────────┘
```

### Discord as Control Plane

Each agent (or agent type) has a dedicated Discord channel:
- `#agent-researcher` — research agent posts findings, accepts new queries
- `#agent-writer` — writing agent posts drafts, accepts revision requests
- `#agent-orchestrator` — high-level task intake and delegation

Human operators interact by posting to channels or reacting with emoji (✅ = approve, ❌ = reject, 🔄 = retry).

This is a clever reuse of existing infrastructure. Discord has:
- Real-time message delivery
- Thread support (per-task conversations)
- Persistent history
- Mobile access
- Multi-user (team can all see and interact)
- No additional UI to build

---

## 4-Stage Pipeline

Every agent run goes through four stages:

```
1. INTAKE      → parse and validate the task
2. RESEARCH    → gather context (web search, memory lookup, file reads)
3. SYNTHESIS   → generate the output
4. REVIEW      → optional human approval before committing
```

Stages are explicit in code. You can hook into any stage, pause at REVIEW for human approval, or configure agents to skip review entirely.

---

## Cognitive Memory (LanceDB)

LanceDB is a vector database that stores agent memories as embeddings:
- Every completed task result is stored with its embedding
- Agents search memory before starting work ("have I done something like this before?")
- Memory is per-agent-type, not per-session

This is semantic memory — agents can find relevant past work even with different phrasing. Unlike OpenClaw's sqlite-vec approach, LanceDB is columnar + vector-native, designed for this use case.

```typescript
// Before starting a task:
const relevant = await memory.search({
  query: "implement OAuth2 login for Express",
  limit: 5,
  agentType: "code-writer"
})
// Returns: similar past tasks + their outputs
```

---

## Agent Definition

```yaml
name: researcher
type: research
model: claude-sonnet

channels:
  input: "#agent-researcher"
  output: "#agent-researcher"
  escalation: "#agent-orchestrator"

memory:
  backend: lancedb
  namespace: researcher

pipeline:
  stages: [intake, research, synthesis]
  review: false   # auto-approve, no human step

tools:
  - web_search
  - file_read
```

---

## What Makes It Interesting

1. **Discord as UI** — this is genuinely clever. Teams already use Discord. Zero new UI to build. Real-time, persistent, mobile-accessible, multi-user. autonomOS should consider a Discord integration path.

2. **4-stage pipeline** — explicit pipeline stages are more predictable than pure agent autonomy. Every task has the same shape: intake → research → synthesis → review. Easy to debug, easy to monitor.

3. **Semantic memory** — LanceDB for long-term agent memory is the right call over file-based approaches for complex agents. Especially powerful for agents that run many times and build knowledge over time.

4. **Per-agent-type memory** — memory is scoped to agent type, not session. A new researcher agent session immediately has access to everything previous researcher sessions learned.

5. **Discord escalation channels** — when an agent is uncertain, it posts to an escalation channel and waits. This is an elegant human-in-the-loop pattern that doesn't block the agent's execution thread.

---

## Weaknesses

- **Discord dependency** — not everyone uses Discord. Teams on Slack or Teams are excluded.
- **LanceDB complexity** — vector DB adds operational overhead. Needs embedding model, index management.
- **Noisy channels** — if agents are active, Discord channels fill fast. Hard to track many parallel agents.
- **No scheduling** — tasks are triggered by Discord messages, not cron. Requires a human to initiate.
- **Python + TypeScript mix** — unclear language boundary creates integration friction.
- **Not personal-scale** — designed for teams with shared Discord workspaces.

---

## Relevance to autonomOS

| Concept | OpenSwarm | autonomOS |
|---------|-----------|-----------|
| Control interface | Discord | Web dashboard + (future: Slack/Discord integration) |
| Memory | LanceDB (vector, semantic) | `state/` folder (files, simple) |
| Pipeline | 4-stage explicit | Agent-defined (via CLAUDE.md) |
| Review/approval | Discord reactions | Dashboard permission prompts |
| Multi-agent | Swarm with escalation | Punted to roadmap |
| Human-in-loop | Discord reactions | Dashboard approve/deny |

### Key borrowings

- **4-stage pipeline** — even for single agents, the INTAKE → RESEARCH → SYNTHESIS → REVIEW model is a good CLAUDE.md template. Document it as a recommended agent design pattern.

- **Escalation channel concept** — when an autonomOS agent is stuck or uncertain, it should be able to escalate to the dashboard (post a message that appears as a notification). Implement as part of the permission/interrupt model.

- **Discord integration as a future path** — not for v1, but the pattern validates that agents should be able to communicate through messaging platforms. Slack webhook support would be more broadly useful than Discord.

- **Per-type semantic memory** — when `state/` files aren't sufficient (agents that do complex research), LanceDB or similar is the right upgrade path. Design `state/` to be replaceable with a vector backend.
