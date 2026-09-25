## ADR-021: Agent Session Model — oneshot vs persistent
**Date:** 2026-03-17
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** Scheduled agents need a session model. Two options: spawn a fresh session per cron tick (stateless), or maintain one long-lived session and message into it (stateful).

**Decision:** Two modes, `oneshot` (default) and `persistent`. Controlled by `schedule.mode` in `agent.json`.

**oneshot (default):**
- Fresh isolated session per cron tick
- Agent reads `state/` at start, does work, writes `state/`, session dies
- No context window growth over time
- Cheap, predictable, maps to OpenClaw's `sessionTarget: "isolated"`

**persistent:**
- One long-lived session, cron tick sends a message into it
- Agent retains full conversation history across ticks
- Context accumulates — requires a compaction/archival strategy
- Use only when multi-turn reasoning across ticks genuinely matters
- Maps to OpenClaw's `sessionTarget: "main"`

**Default to `oneshot`.** Use `persistent` only with a specific stated reason.

**Rationale:**
- `oneshot` avoids context window growth, the primary failure mode for long-running agents (validated by Marc Nuri dashboard research — context % is the key health metric)
- `state/` folder provides all the inter-run continuity needed for most agents
- `persistent` is available for interactive agents or agents where conversational reasoning across ticks is the core value

**Alternatives:**
- **Always oneshot** — simpler but removes the option for genuinely persistent agents.
- **Always persistent** — context bloat, eventual failure. Not viable for 24/7 agents.
- **Auto-compact on overflow** — OpenClaw's approach. Valid for persistent mode but doesn't change the default.
