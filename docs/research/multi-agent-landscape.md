# Multi-Agent Platform Landscape — Comparison

Research from 2026-03-17/18. Covers 7 tools studied in depth: Jinn, Marc Nuri Dashboard,
Claudia/opcode, ccswarm, multiclaude, OpenSwarm, and ComposioHQ Agent Orchestrator.

---

## Quick Reference

| Tool | Stars | Language | Key Idea | Claude-specific? | Scheduling? | Dashboard? |
|------|-------|----------|----------|-----------------|-------------|------------|
| Claudia | 20,800 | Rust+TS | Native GUI + checkpoints | Yes (Claude Code) | No | Yes (desktop) |
| Jinn | ~500 | TypeScript | `claude -p --resume` as API | Yes (CLI) | Yes (cron) | Yes (Next.js) |
| Marc Nuri | N/A | TypeScript | Hook-based observability | Yes (hooks) | No | Yes (web) |
| ccswarm | ~200 | Rust | Actor model + type-state | Yes | No | No |
| multiclaude | ~100 | Go | Files + tmux (Brownian Ratchet) | Yes (CLI) | No | No |
| OpenSwarm | ~150 | TS+Python | Discord control + LanceDB memory | No (agnostic) | No | Discord |
| Agent Orchestrator | ~300 | TS+Python | LLM-as-orchestrator, 8 plugins | No (agnostic) | No | No |

---

## Capability Matrix

| Capability | Jinn | Marc Nuri | Claudia | ccswarm | multiclaude | OpenSwarm | AgentOrch |
|------------|------|-----------|---------|---------|-------------|-----------|-----------|
| Cron scheduling | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Hot reload | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Session checkpointing | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Context % visibility | ❌ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| Multi-agent coordination | 🟡 MCP mesh | ❌ | ❌ | ✅ DAG | ✅ files | ✅ Discord | ✅ LLM orch |
| Semantic memory | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| Permission prompts visible | ❌ | ✅ | ❌ | ❌ | ❌ | 🟡 Discord | ❌ |
| Remote access | ✅ | ✅ | ❌ | ❌ | ❌ | ✅ Discord | ❌ |
| Agent definitions | YAML | None | SQLite | Code | YAML | YAML | Plugin slots |
| State persistence | SQLite | N/A | N/A | External | Files | LanceDB | N/A |

---

## Unique Insights Per Tool

### Jinn — "claude -p --resume as infrastructure"
**What no one else does:** Repurposing the Claude CLI as a session-resumable API. Avoids API billing entirely on Claude Max. The MCP-mesh pattern (agents as MCP servers) is an elegant peer model.

**autonomOS relevance (HIGH):** Validates YAML+CLAUDE.md co-location. Hot-reload via file watcher is table stakes for a good operator experience. `claude -p --resume` is a future backend option for Claude Max users.

### Marc Nuri — "context % is the primary metric"
**What no one else does:** Explicit observability of context window fill as the primary agent health metric. The enricher pipeline (fast heartbeat + slow enrichers) is a clean architecture for agent telemetry.

**autonomOS relevance (HIGH):** Context % must appear in the autonomOS dashboard. Three states (working/idle/awaiting-permission) should be the canonical session state model.

### Claudia — "git-like session branching"
**What no one else does:** Checkpoints and branch-from-checkpoint for conversation history. The most-starred tool because it solves the most common interactive UX need.

**autonomOS relevance (MEDIUM):** Usage tracking (tokens + cost per session) is a must-have dashboard feature. The checkpoint model is future scope but the framing is valuable — `state/` folder under git version control is a lightweight equivalent.

### ccswarm — "type-state lifecycle + 93% token reduction"
**What no one else does:** Compile-time session lifecycle safety via Rust type-state. Role-based context partitioning for 93% token reduction.

**autonomOS relevance (MEDIUM):** TypeScript discriminated unions for session state is directly adoptable. Token efficiency principles (don't let orchestrators carry worker history) inform future multi-agent design.

### multiclaude — "Brownian Ratchet"
**What no one else does:** The philosophical framing: filesystem as a ratchet that preserves progress. Agents push forward; durable files ensure nothing regresses.

**autonomOS relevance (MEDIUM):** The Brownian Ratchet concept is the right mental model for `state/` files. Document this in autonomOS's architecture notes.

### OpenSwarm — "Discord as control plane + semantic memory"
**What no one else does:** Discord channels as agent control/output. LanceDB for per-agent-type semantic memory that persists across sessions.

**autonomOS relevance (MEDIUM):** Escalation/notification path (agents posting to a channel when stuck) is a pattern to implement. Semantic memory (LanceDB) is the right upgrade path when `state/` files become insufficient.

### Agent Orchestrator — "LLM-as-orchestrator"
**What no one else does:** The orchestrating intelligence is itself an LLM, not routing code. Built substantially by the agents it orchestrates.

**autonomOS relevance (HIGH for roadmap):** When autonomOS builds multi-agent support, the orchestrator should be a Claude agent reading agent YAML definitions. "Built by itself" is the long-term north star.

---

## What autonomOS Does That None of These Do

1. **Folder-based composable agent definitions** — version-controllable, shareable, addable by dropping a folder. No one else does this cleanly.

2. **Dashboard + scheduler + SDK abstraction in one package** — most tools are point solutions: Claudia is UI-only, ccswarm is framework-only, Jinn is scheduler+minimal-UI. autonomOS integrates all three.

3. **Robot/persistent agent platform** — these tools all assume interactive or short-lived sessions. autonomOS is designed for long-running 24/7 agents (home automation, etc.).

4. **AgentRuntime abstraction** — decoupling from Anthropic SDK for future custom runtime. None of these plan beyond their current SDK dependency.

5. **OpenClaw model borrowed thoughtfully** — autonomOS takes OpenClaw's session model and makes it extensible without importing OpenClaw's complexity.

---

## Key Decisions Informed by This Research

| Decision | Evidence |
|----------|----------|
| Context % is a dashboard must-have | Marc Nuri + Claudia both surface it |
| Three session states: working/idle/awaiting-permission | Marc Nuri validates this model |
| `state/` as Brownian Ratchet | multiclaude + ccswarm both externalize agent state |
| File watcher for hot-reload | Jinn demonstrates operators expect this |
| Folder-based definitions (not SQLite) | Claudia's SQLite shows the limitation (not version-controllable) |
| Orchestrator agent for multi-agent | Agent Orchestrator validates LLM-as-orchestrator |
| MCP mesh for inter-agent (roadmap) | Jinn proves it's workable; OpenSwarm's Discord is alternative |
| Discord/Slack integration (roadmap) | OpenSwarm: teams use what they already use |
| Semantic memory upgrade path (roadmap) | OpenSwarm: LanceDB when files aren't enough |
| Token efficiency metrics | ccswarm: 93% reduction is achievable, should benchmark |
