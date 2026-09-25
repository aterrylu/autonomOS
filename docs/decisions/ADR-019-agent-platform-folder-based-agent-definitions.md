## ADR-019: Agent Platform — Folder-Based Agent Definitions
**Date:** 2026-03-17
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** Need a model for defining, storing, and running autonomous agents in autonomOS. Options ranged from monolithic config files (OpenClaw's `openclaw.json`) to database-backed entries (Claudia's SQLite) to folder-per-agent structures.

**Decision:** Flat folder-per-agent under `~/.autonomos/agents/`. Each agent is a self-contained directory:
```
~/.autonomos/
├── CLAUDE.md                        # base context for ALL agents
├── OWNER.md                         # owner profile, injected for all agents
└── agents/
    └── home-presence/
        ├── agent.json               # schedule, model, display metadata
        ├── state/                   # shared across all sessions of this agent
        └── .claude/
            ├── CLAUDE.md            # agent-specific behavior
            ├── settings.json        # allowed tools, permissions, MCP servers
            └── skills/
```

**agent.json schema (deliberately minimal):**
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

`agent.json` only contains what the autonomOS runner needs: **name, description, model, schedule.** Everything else (allowed tools, permissions, hooks, MCP servers) lives in `.claude/settings.json` where Claude Code already expects it. No duplication.

**Rationale:**
- Adding an agent = dropping a folder. No central config file to edit.
- Each agent is independently version-controllable and shareable.
- JSON over YAML — consistent with `.claude/settings.json`, no YAML parser dependency.
- `agent.json` is deliberately thin: only runner concerns. Agent capabilities/permissions stay in `.claude/` where Claude Code already handles them.
- Mirrors how Claude Code itself works (`.claude/` folder = local config). Familiar mental model.
- Flat structure avoids hierarchy complexity. All agents are peers.
- Validated by Jinn (config + adjacent CLAUDE.md) and OpenClaw (flat agent list).

**Alternatives:**
- **Monolithic config** (OpenClaw model) — editing a central file to add agents. Not composable.
- **SQLite rows** (Claudia model) — not version-controllable, GUI-required to edit.
- **YAML instead of JSON** — readable but adds a parsing dependency. JSON is native to Node.js and consistent with the rest of the `.claude/` ecosystem.
- **Hierarchical template/instance model** — `templates/` + `agents/` with singleton/multi/job split. Too confusing for v1. Collapsed to flat.
- **Put allowedTools in agent.json** — duplication. `.claude/settings.json` already handles this and is what the SDK reads.
