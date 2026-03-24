# Marc Nuri's AI Coding Agent Dashboard

**By:** Marc Nuri (marcnuri-com)
**Source:** https://blog.marcnuri.com/ai-coding-agent-dashboard
**Repo:** Not public (personal tool)
**Language:** TypeScript (implied)
**Status:** Personal production use

---

## What It Is

A personal dashboard for monitoring and managing long-running Claude Code agent sessions across multiple machines. Built by Marc Nuri, a software engineer who uses Claude Code agents as continuous background workers. The system provides real-time visibility into what every agent is doing and lets him intervene when one gets stuck awaiting permission.

Primary insight: **context percentage is the most important metric for long-running agents.** When context fills, the agent's reasoning degrades. Dashboard-level visibility into this is the core value prop.

---

## Architecture

```
Agent Machine 1              Control Plane              Browser
claude-code session ──hooks──► WebSocket Server ◄──────► Dashboard
                               (relay)                   (React/Next)
Agent Machine 2
claude-code session ──hooks──►
```

**Cross-device relay:** Agents run on one or more machines. The dashboard runs in a browser. A central WebSocket server relays events bidirectionally. This is a solved problem for Marc — the complexity is in the hooks pipeline.

---

## Hook-Based Heartbeat Pipeline

Marc uses Claude Code's hooks system (PreToolUse, PostToolUse, Stop, etc.) as the event source. The pipeline has two stages:

### Stage 1: Heartbeat Hook
Every tool call emits a heartbeat event:
```json
{
  "session_id": "...",
  "timestamp": "...",
  "tool": "Write",
  "status": "working"
}
```

### Stage 2: Enricher Hooks
Separate hooks run after tool calls to compute derived state:
- **Context %** — reads `~/.claude/projects/<id>/*.jsonl` to count tokens in conversation history, divides by model context limit
- **Current task** — parses recent assistant messages to extract what the agent thinks it's doing
- **Error detection** — scans for stack traces or error patterns in tool results

Enrichers are decoupled from heartbeats — they can be slow without blocking the agent.

---

## Session State Model

Three states visible in the dashboard:

| State | Description | Dashboard Treatment |
|-------|-------------|---------------------|
| **Working** | Tool calls flowing, heartbeat recent | Green indicator, last tool shown |
| **Idle** | No tool calls for N minutes | Yellow, "idle since X" |
| **Awaiting Permission** | Agent paused at permission prompt | Red alert, requires human action |

**"Awaiting Permission" is the killer use case.** Agents that need to run a destructive command (e.g., `rm -rf`) pause and wait. Without the dashboard, you'd have to SSH into each machine and check. With it, you see the prompt in the browser and approve/deny.

---

## Key Metrics Tracked

- **Context %** — most important. Shows how close the session is to context limit.
- **Session duration** — how long the current session has been running
- **Tool call rate** — calls/minute (proxy for "is it actually doing work?")
- **Last N tool calls** — recent activity log
- **Error count** — how many tool calls returned errors in this session

---

## Permission Handling

The "awaiting permission" state is detected when the heartbeat stops and the last event was a permission request. The dashboard shows:
- The permission prompt text
- Which tool triggered it
- Approve / Deny buttons

Approving sends a message back through the relay, which... (this part is unclear from the blog post — possibly writes to a file that the session's hook reads, or uses `claude -p` to inject a message).

---

## What Makes It Interesting

1. **Hooks as telemetry** — Claude Code hooks are the only non-invasive way to get real-time data from a running session. Marc maximizes this. autonomOS should do the same.

2. **Context % as primary metric** — this is the key insight. It's not uptime, not error rate — it's context window fill. That determines when you need to act (compact, summarize, or restart).

3. **Cross-device relay** — separates the control plane from the agent plane. Agents don't need to know about the dashboard.

4. **Enricher pipeline** — decoupled post-processing of raw events. Heartbeat = lightweight, enrichers = can be slow. This is a clean architecture.

5. **Awaiting permission as first-class state** — treating permission prompts as a distinct session state that requires human action is the right model for semi-autonomous systems.

---

## Weaknesses

- **Not public** — no repo, no library. Must reimplement.
- **Claude Code specific** — hooks tie it to Claude Code CLI. Doesn't work with Agent SDK or other runners.
- **Single-user, personal scale** — not designed for multi-user or team deployments.
- **Context % calculation is fragile** — reading JSONL files directly is an implementation detail of Claude Code that could change.
- **No session control** — can view and approve permissions but can't restart, kill, or redirect sessions from the dashboard.

---

## Relevance to autonomOS

| Concept | Marc Nuri | autonomOS |
|---------|-----------|-----------|
| Event source | Claude Code hooks (PostToolUse etc.) | Agent SDK hooks (`on_tool_end` etc.) |
| Session state | working/idle/awaiting-permission | TBD |
| Key metric | Context % | Context % + token cost |
| Cross-device | WebSocket relay | WebSocket in `packages/server/` |
| Permission handling | Dashboard approve/deny | TBD |
| Agent definition | Not covered (personal scripts) | `agent.yaml` + `.claude/CLAUDE.md` |

### Key borrowings

- **Context % as primary metric** — autonomOS dashboard must show this. Read from Agent SDK's token usage in responses, not from JSONL files (cleaner).
- **Three session states** — adopt working/idle/awaiting-permission as the canonical state model for the dashboard.
- **Enricher pipeline pattern** — Agent SDK hooks can feed a lightweight event stream; enrichers run async to compute derived state. Don't make the main hook path slow.
- **Permission as first-class** — when `settings.json` has `"alwaysAllow": false` for a tool, the session should surface this clearly in the dashboard UI rather than silently stalling.

### Gaps this doesn't cover

- Agent definition / configuration
- Scheduling and lifecycle management
- Inter-agent communication
- State persistence across sessions
