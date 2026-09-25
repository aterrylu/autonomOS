## ADR-022: OWNER.md Convention — No Formal Audience Types
**Date:** 2026-03-17 (revised 2026-03-19)
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** Initially designed a formal `audience.type` field in agent config (personal/service/dedicated) to handle different user profiles. On reflection, all current agents are personal tools — the distinction is premature and adds complexity to `agent.json` for hypothetical use cases.

**Decision:** Drop formal audience types. Keep a single convention:

- **`OWNER.md`** at `~/.autonomos/OWNER.md` — describes the owner (Terry). Injected into the systemPrompt for all agents by the runner.
- If a specific agent serves a different person, the agent author handles this in the agent's own `.claude/CLAUDE.md` or drops a `persona.md` in the agent folder. No framework support needed.
- Multi-user / service agent patterns are punted entirely.

**Rationale:**
- All agents Terry builds now are personal. "Service" and "dedicated" types are solving problems that don't exist yet.
- OWNER.md covers 100% of current use cases — agents know who Terry is.
- Outward-facing agents (if ever needed) can define their own user context in CLAUDE.md. This is agent-specific logic, not platform logic.
- Keeps `agent.json` minimal — no `audience` field.

**Alternatives:**
- **Formal audience.type field** (original ADR-022) — three types with different USER.md and session allocation strategies. Over-engineered for a personal tool.
- **No OWNER.md at all** — agents wouldn't know who they serve. Simple but misses easy personalization.
