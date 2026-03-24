# Agent vs Session Identity — Design Exploration

Research from design session on 2026-03-19. The core design dilemma for autonomOS's
agent platform: what is the relationship between an agent (identity) and its sessions
(context windows)?

---

## The Problem

An **agent** is an identity — it has a name, personality, knowledge, and capabilities.
A **session** is a context window — it has a conversation history and will eventually fill up or end.

Identity should be continuous. Context windows are finite and isolated.

When the same agent runs in multiple sessions (interactive + cron, or multiple channels),
the sessions don't know about each other. This creates **split-brain**: you tell Agent A
something in Session 1, but Session 2 doesn't know.

**Concrete example (OpenClaw):** Nox exists in Discord #general and Discord #coding.
You tell Nox in #general "I'm not working on project X anymore." Nox in #coding doesn't
know. They're the same agent with the same SOUL.md and personality, but their sessions
are isolated. This feels wrong — they're the same person.

---

## Three Levels of "Knowing"

| Level | Example | Persistence | Shared? |
|-------|---------|-------------|---------|
| **Capabilities** | "I can read files and run bash" | `.claude/settings.json` | Yes — all sessions share config |
| **Knowledge** | "Terry stopped working on project X" | Memory layer (TBD) | Should be, but isn't automatic |
| **Conversation** | "Terry just asked about cameras 30 seconds ago" | Context window | No — ephemeral, per-session |

The design question: **where does the boundary between Knowledge and Conversation sit?**

- Share everything → context pollution, cost, confusion
- Share nothing → split-brain, repetition, frustration

---

## How Existing Systems Handle This

### Claude Code — no shared identity

Each session starts from zero. `.claude/` gives shared capabilities but not shared knowledge.
The auto-memory system (`MEMORY.md`) is per-project, not per-agent-identity.

- **Capabilities:** Shared via `.claude/` ✅
- **Knowledge:** Not shared ❌ (MEMORY.md is a partial fix, per-project)
- **Conversation:** Isolated ✅ (correct)

### OpenClaw — shared identity, fragile knowledge bridge

Agent definition (SOUL.md, personality) is shared. Memory DB (sqlite-vec) is shared but
only written at the agent's discretion via `memory_save` tool. Sessions are isolated.

- **Capabilities:** Shared via agent config ✅
- **Knowledge:** Shared via memory DB, but unreliable — agent must choose to persist ⚠️
- **Conversation:** Isolated ✅ (correct)

**The gap:** Memory writes are optional. The LLM doesn't reliably know what's "important
enough" to persist. The `sessions_send` tool (A2A) allows cross-session messaging but
that's active communication, not passive knowledge sharing.

### A2A Protocol — no opinion

A2A is a wire protocol. Identity continuity is the agent's problem, not the protocol's.

---

## Four Models for autonomOS

### Model 1: Single session per agent (no multi-session)

One agent = one active session at a time.

```
home-presence agent → exactly 1 session
                      cron ticks into it (persistent) or spawns fresh (oneshot)
```

**Pros:** No split-brain. No identity continuity problem. Simplest possible model.
**Cons:** Agent can't do two things at once. Can't have the same agent in two channels.
**Best for:** Single-purpose agents (monitors, schedulers, workers). Most personal agents.

### Model 2: Multi-session with explicit memory protocol

Multiple sessions share a `state/` folder. The agent's CLAUDE.md instructs it to
persist important facts to `state/memory.json` and read them on start.

```
agent
├── Session A (cron) → reads state/ → works → writes state/
├── Session B (interactive) → reads state/ → sees A's updates
└── state/
    ├── memory.json    ← shared knowledge layer
    ├── cameras.json   ← domain state
    └── decisions.json ← "Terry said stop project X"
```

Memory write discipline is enforced via the base CLAUDE.md:

```markdown
## Memory Protocol
You have persistent memory at state/memory.json.
- READ it at the start of every session
- WRITE to it when the user tells you something that should persist
- Format: JSON array of {timestamp, fact, source}
```

**Pros:** Identity continuity via explicit state. Debuggable (files). Human-readable.
**Cons:** Agent must be prompted to persist the right things. Latency between sessions.
**Best for:** General-purpose agents that need identity continuity (Nox-like).

### Model 3: Event log + read-on-start

Every session appends to a shared event log. New sessions read recent events on start.

```
state/
└── events.jsonl
    {"ts":"...","session":"A","type":"user_said","fact":"stop project X"}
    {"ts":"...","session":"A","type":"decision","fact":"marked project X inactive"}
```

**Pros:** Automatic — less judgment about what to persist. Full audit trail.
**Cons:** Unbounded growth. Needs compaction. Expensive to read on start.
**Best for:** Agents where completeness matters more than simplicity.

### Model 4: Semantic memory (vector DB)

All sessions write to and query a shared vector DB (LanceDB, sqlite-vec).
Sessions can search memory mid-conversation: "do I know anything about this?"

**Pros:** Semantic search. Real-time cross-session awareness. Scales well.
**Cons:** Infrastructure overhead (vector DB, embedding model). Overkill for most agents.
**Best for:** Long-running general-purpose agents with years of accumulated knowledge.

---

## Model Comparison

| | Model 1 | Model 2 | Model 3 | Model 4 |
|--|---------|---------|---------|---------|
| **Multi-session** | No | Yes | Yes | Yes |
| **Knowledge sharing** | N/A | Explicit (prompted) | Automatic (event log) | Semantic search |
| **Infrastructure** | None | Files only | Files + compaction | Vector DB |
| **Write discipline** | N/A | Agent must be instructed | Automatic | Automatic |
| **Read latency** | N/A | On start only | On start (window) | Real-time query |
| **Debuggability** | ✅ | ✅ (human-readable files) | ✅ (human-readable log) | ⚠️ (need DB tooling) |
| **Closest analog** | Claude Code | OpenClaw (improved) | multiclaude | OpenSwarm |

---

## The Key Insight

**The split-brain problem is a memory write discipline problem, not an architecture problem.**

If the agent reliably writes important facts to `state/memory.json`, every session sees
them. OpenClaw's gap isn't that it lacks a memory mechanism (sqlite-vec exists). It's that
the agent doesn't reliably USE it. Making memory writes part of the agent's core behavioral
instructions — not optional — is the design lever.

This means the fix is primarily in **prompt engineering** (the base CLAUDE.md memory protocol)
with file-based infrastructure (`state/`) as the backing store. No vector DB needed for v1.

---

## Recommendation

**Default: Model 1** — single session per agent. Most agents don't need multi-session.

**For general-purpose agents: Model 2** — multi-session with explicit memory protocol
in the base CLAUDE.md. The `state/` folder is the shared knowledge layer.

**Future upgrade path: Model 4** — when `state/` files aren't enough (agent has thousands
of memories, needs semantic search), swap the backing store to LanceDB. The `state/` folder
is the abstraction seam — today it's files, tomorrow it's a DB.

---

## Open Questions

1. **Memory protocol specifics** — what JSON schema for `state/memory.json`? How does the
   agent decide what's a "fact" vs conversation ephemera? How much prompt engineering does
   this take to get reliable?

2. **Real-time cross-session awareness** — Model 2 only syncs on session start. If Session A
   learns something important mid-run, Session B won't see it until Session B restarts. Is
   this acceptable for v1?

3. **Memory compaction** — `state/memory.json` will grow. When does it get summarized/pruned?
   Who does the pruning — the agent itself, or the runner?

4. **Conflict resolution** — if Session A and Session B both write to `state/memory.json`
   simultaneously, who wins? File locking? Last-write-wins? Append-only JSONL?

5. **How much is agent vs platform?** — should the memory protocol be enforced by the runner
   (read state/ and inject into systemPrompt automatically) or by the CLAUDE.md instructions
   (agent reads state/ itself)? Runner-injected is more reliable but less flexible.
