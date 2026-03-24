# ccswarm

**By:** Anthropic community / independent
**License:** MIT
**Language:** Rust
**Repo:** https://github.com/anthropics/ccswarm (or community equivalent)
**Focus:** Multi-agent coordination with extreme token efficiency

---

## What It Is

ccswarm is a Rust-based multi-agent orchestration framework designed around two ideas: the **actor model** for agent isolation, and **type-state patterns** for compile-time session lifecycle safety. Its headline claim: **93% token reduction** compared to naive multi-agent approaches.

This is an engineering-first project — correctness and efficiency over developer ergonomics. The target user is someone building production multi-agent systems who cares deeply about cost and reliability.

---

## Architecture

### Actor Model

Each agent is an independent actor (Rust `tokio` task or thread):
- Actors communicate via message channels, not shared memory
- Each actor owns its own state — no locks, no mutexes
- Failure of one actor doesn't cascade to others

```
┌──────────────┐    channel    ┌──────────────┐
│  Orchestrator│ ─────────────►│  Agent A     │
│  Actor       │               │  Actor       │
└──────────────┘               └──────────────┘
       │ channel
       ▼
┌──────────────┐
│  Agent B     │
│  Actor       │
└──────────────┘
```

### Type-State Pattern

Session lifecycle is encoded in Rust's type system:
```rust
Session<Idle>      // can be started
Session<Running>   // can receive messages, be paused
Session<Paused>    // can be resumed or terminated
Session<Terminated> // terminal state, immutable
```

Invalid transitions are compile errors. You cannot accidentally send a message to a terminated session — the compiler rejects it. This is zero-cost runtime safety.

---

## Token Reduction Strategy (93% claim)

The 93% reduction comes from structured context compression:

1. **Role separation** — different agents see different context. An orchestrator sees high-level task summaries; a worker sees only its immediate task. No agent carries the full conversation history.

2. **Structured summaries** — completed subtasks are compressed into structured summaries (not raw conversation). Summary format is typed (JSON schema), not freeform.

3. **State externalization** — agent state lives in files, not in the conversation. Agents read state at start of each task, don't carry it in context.

4. **Tool result truncation** — large tool outputs (file contents, bash output) are truncated and summarized before entering context.

Result: each agent's context window contains only what it needs for its current task. The orchestrator's context stays small because it never sees worker conversation details — only outcomes.

---

## Orchestration Model

Orchestrator breaks work into subtasks:
```
Task: "Build feature X"
  → Subtask 1: "Analyze existing code" → Agent A
  → Subtask 2: "Write tests" → Agent B
  → Subtask 3: "Implement feature" → Agent C (depends on 1)
  → Subtask 4: "Review" → Agent A (reused)
```

Dependencies expressed as a DAG. ccswarm handles topological scheduling — subtask 3 waits for subtask 1 automatically.

Agents are **reusable** — the same agent actor can handle multiple subtasks across different tasks. Agent specialization (e.g., "code writer", "reviewer") is via system prompt, not process identity.

---

## What Makes It Interesting

1. **Type-state sessions** — encoding session lifecycle in types is the right model for correctness. No runtime state machine bugs. autonomOS could adopt this in TypeScript with discriminated unions.

2. **Role-based context partitioning** — the 93% reduction is mostly from this. Orchestrators don't need worker chat history; workers don't need orchestrator strategic context. Clean separation.

3. **DAG task scheduling** — explicit dependency management for multi-agent workflows. Better than implicit ordering.

4. **Rust actor model** — extreme isolation. Each agent truly cannot corrupt another's state. Overkill for v1 autonomOS but the right long-term model.

---

## Weaknesses

- **Rust** — high barrier to adoption and contribution. Not web-friendly.
- **No dashboard** — pure library/framework, no UI.
- **Orchestration complexity** — DAG task graphs are powerful but require more upfront design than simple sequential agents.
- **Claude-specific optimizations** — token reduction strategies assume Claude's specific context handling. May not generalize.
- **No scheduling** — tasks are kicked off programmatically, not via cron or events.

---

## Relevance to autonomOS

| Concept | ccswarm | autonomOS |
|---------|---------|-----------|
| Agent isolation | Rust actors (OS threads) | Session abstraction |
| Session lifecycle | Type-state pattern | TBD |
| Token efficiency | Role separation + structured summaries | `state/` as context replacement |
| Multi-agent | DAG task orchestration | Punted to roadmap |
| Language | Rust | TypeScript |
| UI | None | React dashboard |

### Key borrowings

- **Type-state session lifecycle** — in TypeScript, use discriminated unions for session state:
  ```typescript
  type Session =
    | { status: 'idle' }
    | { status: 'running'; sessionId: string }
    | { status: 'paused'; resumeToken: string }
    | { status: 'terminated'; outcome: string }
  ```
  This makes invalid transitions a type error rather than a runtime bug.

- **Role-based context partitioning** — when autonomOS supports multi-agent workflows, don't let orchestrators see full worker conversation history. Share structured summaries only.

- **Structured state files** — ccswarm's state externalization validates the `state/` folder approach. Structured JSON > raw conversation history for agent memory.

- **93% number to benchmark against** — when autonomOS eventually builds multi-agent features, token efficiency should be a first-class metric. ccswarm sets the bar.
