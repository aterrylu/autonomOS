# A2A Protocol — autonomOS Integration Analysis

**Date:** 2026-03-19
**Decision needed:** Should autonomOS adopt A2A as its inter-agent communication protocol?

---

## The Core Question

autonomOS is building a multi-agent orchestration platform. It needs agents to:
1. **Advertise** what they can do (capability discovery)
2. **Accept tasks** from an orchestrator
3. **Report progress** back (status, streaming updates)
4. **Return outputs** (artifacts, results)

A2A is designed to solve exactly this. The question is: **adopt now, later, or never?**

---

## What autonomOS Currently Has

From the multi-agent-coordination research:
- **Session spawning** via node-pty (Claude Code sessions)
- **Observability** via hook telemetry (PreToolUse/PostToolUse events)
- **Introspection** via fork+query pattern on idle sessions
- **Intervention** via PTY stdin writes
- **Task tracking** via shared JSONL files

What's missing for true orchestration:
- No formal capability advertisement (agents don't say what they can do)
- No structured task delegation protocol (only stdin injection)
- No formal task lifecycle (no submitted/working/completed states)
- No artifact tracking (agent outputs are just text in JSONL)

---

## How A2A Would Fit

### Option A: autonomOS as an A2A Orchestrator (Client)

autonomOS acts as the A2A client, delegating tasks to A2A-compliant agents:

```
autonomOS Orchestrator (A2A Client)
    │
    ├── discovers Agent Cards from all registered agents
    ├── sends tasks via message/send or message/stream
    ├── tracks task state (submitted → working → completed)
    └── receives artifacts as task outputs

Claude Code Agent (wrapped as A2A Server)
    │
    ├── publishes Agent Card at /.well-known/agent.json
    ├── accepts tasks via JSON-RPC
    └── reports status and artifacts back
```

This gives us a formal, auditable task delegation layer with proper state tracking.

### Option B: autonomOS as an A2A Server (for external orchestrators)

autonomOS exposes itself as an A2A server so external A2A orchestrators (LangGraph, CrewAI, etc.) can delegate tasks to it, and autonomOS in turn manages Claude Code sessions to fulfill those tasks.

### Option C: Full A2A Mesh

autonomOS manages a mesh of A2A agents. Each Claude Code session is wrapped as an A2A server. autonomOS orchestrates via A2A as the client. External agents can also join the mesh as A2A servers.

This is the most powerful but highest complexity.

---

## The "Wrapping Claude Code as A2A" Problem

The fundamental challenge: **Claude Code sessions are not HTTP servers**. They are:
- Spawned as PTY processes
- Communicate via stdin/stdout
- No built-in HTTP endpoint
- No concept of Agent Card

To expose a Claude Code session as an A2A server, autonomOS would need to:
1. Spawn the Claude Code session (already does this via node-pty)
2. Wrap it with an HTTP proxy that implements the A2A JSON-RPC interface
3. Generate a dynamic Agent Card per session (based on session config / task type)
4. Route A2A `message/send` calls to Claude's stdin
5. Parse Claude's stdout/JSONL to extract task state and artifacts
6. Report back via A2A response and streaming events

This is a non-trivial but achievable adapter layer. It would be the core of autonomOS's value — it's the bridge between the "real-time PTY world" and the "structured A2A world".

---

## Fit Analysis

### Strong Fit
- **Task lifecycle model** maps cleanly to what autonomOS tracks anyway (what is an agent doing, is it done, what did it produce)
- **Artifacts** formalize what's currently just text in JSONL — autonomOS should be tracking agent outputs as first-class objects
- **`input-required` state** is exactly what the permission prompt handling already detects via hooks — we could surface this as a proper A2A state
- **Agent Card per workspace/session** would give autonomOS a structured way to define what each session specializes in (frontend agent, backend agent, QA agent)
- **contextId grouping** maps to autonomOS's existing concept of "projects" that span multiple sessions

### Weaker Fit
- **Agent Cards require HTTP servers** — Claude Code sessions don't have one; needs adaptation
- **Cross-framework interop is not our immediate need** — we're Claude Code-only right now; A2A's primary value is heterogeneous agent ecosystems
- **Overhead for solo use** — if it's just Terry + autonomOS + Claude Code sessions, the protocol overhead may not add value vs direct PTY control
- **The "opaque agent" model** may be too loose — we actually want deep observability into Claude Code agents (JSONL introspection, fork+query), which A2A explicitly does not provide

---

## Recommendation

### Phase 1 (Now — internal use): Don't adopt A2A yet

Continue with the current PTY/hook/JSONL architecture. It's simpler, gives us more observability, and doesn't require wrapping sessions as HTTP servers. The fork+query pattern for introspection is unique to Claude Code and would be lost behind an opaque A2A interface.

Instead, **design the internal task model to be A2A-compatible** — use the same state machine (submitted, working, input-required, completed, failed) and artifact concepts, even if the transport is internal message passing.

### Phase 2 (When autonomOS accepts external agents): Adopt A2A

When autonomOS needs to accept tasks from external orchestrators, or when users run non-Claude Code agents (LangGraph, CrewAI, etc.), implement:
1. An A2A server endpoint in autonomOS so external orchestrators can delegate to it
2. An A2A client in autonomOS so it can delegate to external A2A agents
3. Keep the Claude Code session adapter internal — Claude sessions remain PTY-native with full observability, but autonomOS translates A2A ↔ PTY at the boundary

### Phase 3 (Multi-org or marketplace): Full A2A mesh

If autonomOS ever becomes a platform others build on, expose session Agent Cards publicly and enable agent discovery across organizations.

---

## Concrete A2A Alignment Actions for Phase 1

Even without adopting A2A now, align the internal data model:

1. **Task states** — adopt submitted/working/input-required/auth-required/completed/failed/canceled as autonomOS's internal session states (maps cleanly to hook event patterns)

2. **Artifacts** — introduce an artifact model for agent outputs. When an agent produces a file, generates code, or completes a deliverable, record it as an artifact with type, content, and metadata.

3. **Session "Agent Card" concept** — introduce a session configuration schema that acts like an Agent Card: what is this session specialized for, what tags does it have, what kind of tasks should be routed to it?

4. **contextId** — add a `projectId` or `contextId` concept to group related sessions under a project (this is already in the roadmap as the "projects" concept).

This alignment means when we're ready to add A2A transport, the protocol mapping will be straightforward — the internal model already speaks A2A semantics.

---

## Key Risk: A2A vs autonomOS's Observability Advantage

A2A treats agents as opaque by design. autonomOS's differentiation is deep observability — we can fork+query any session, read JSONL in real-time, see every tool call. If we expose Claude Code sessions purely as A2A agents, we lose that differentiation for external clients.

**Resolution:** Don't expose the A2A interface to external clients for observability. Use A2A for task delegation (the structured "what" layer) while maintaining the hook/JSONL/fork pattern for observability (the "how" layer). These serve different purposes and don't conflict.
