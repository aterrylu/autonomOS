# autonomOS — Agent Development Guide

## Start Here

1. Read [`README.md`](README.md) — project overview, monorepo structure
2. Read [`docs/DECISIONS.md`](docs/DECISIONS.md) — all architectural decisions with context and rationale
3. Read [`docs/ROADMAP.md`](docs/ROADMAP.md) — current priorities and what to work on
4. Read [`docs/RESEARCH.md`](docs/RESEARCH.md) — research findings, competitor analysis, learnings

## Project Vision

autonomOS is an **orchestrator agent for autonomous development** — an agent that manages agents across workspaces and projects.

**Core concepts:**
- **Orchestrator** — PM agent, the main interface. Understands project goals, delegates to workspace agents, tracks progress.
- **Projects** — Logical goals with roadmaps. Can span multiple workspaces. Multiple projects per workspace.
- **Workspaces** — Physical repositories, auto-discovered. Each has active agent sessions.

Two paths that share a common core:
- **Dev Path** — orchestrator for agent tools (Claude Code, OpenClaw, etc.)
- **Robot Path** — persistent agent platform for robotics (aspirational, future)

## Monorepo Structure

```
autonomOS/
├── packages/
│   ├── dashboard/          # Web UI — observability & control
│   ├── server/             # Hono + node-pty — API, WebSocket, PTY management
│   └── core/               # Shared agent abstractions & types
├── docs/
│   ├── DECISIONS.md        # Architectural Decision Records (append-only)
│   ├── ROADMAP.md          # Current priorities
│   └── RESEARCH.md         # Research findings & competitor analysis
├── CLAUDE.md               # This file — agent development guide
└── README.md               # Project overview
```

## Key Conventions

### Decision Records (CRITICAL)
Every architectural decision goes in `docs/DECISIONS.md`. Append-only. Each entry must include:
- **Date** and **who decided** (human vs agent)
- **Context** — why this decision was needed
- **Decision** — what was chosen
- **Rationale** — why this over alternatives
- **Alternatives considered** — what else was evaluated
- **Source** — where the decision happened (Discord channel, CC session, etc.)

Never delete or modify past entries. If a decision is reversed, add a new entry referencing the old one.

### Research & Learnings
All research goes in `docs/RESEARCH.md` or `docs/research/` subdirectories. When investigating competitors, frameworks, or approaches:
- Document what you found with links
- Note what's relevant to autonomOS
- Include your assessment (not just raw info)

### Commit Messages
- `init:` — initial setup
- `docs:` — documentation changes
- `feat:` — new features
- `fix:` — bug fixes
- `research:` — research findings
- `refactor:` — structural changes

### Development Philosophy
- **Observe first, control later** — dashboard starts read-only
- **Don't reinvent** — build on OpenClaw for now, diverge only when needed
- **Personal tool first** — ship for Terry, generalize later
- **Both paths share core** — abstractions should work for dev agents AND robots

## What NOT to Do

- Don't make architectural decisions without recording them in DECISIONS.md
- Don't start building without checking ROADMAP.md for priorities
- Don't ignore existing research — check RESEARCH.md before investigating something
- Don't over-engineer for the robot path yet — it's aspirational
- Don't build a new agent runtime from scratch — start with OpenClaw integration

## Agent Workflow

When working on this repo:
1. Check ROADMAP.md — what's the current priority?
2. Check DECISIONS.md — has this been decided already?
3. Do the work
4. Update ROADMAP.md if priorities shifted
5. Add any new decisions to DECISIONS.md
6. Update RESEARCH.md with any new findings
