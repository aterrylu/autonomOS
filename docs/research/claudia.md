# Claudia (by getAsterisk / opcode)

**By:** getAsterisk / opcode team
**License:** MIT
**Language:** Rust (Tauri) + TypeScript (React frontend)
**Repo:** https://github.com/getAsterisk/claudia (also known as opcode)
**Stars:** ~20,800
**Status:** Active development, widely used

---

## What It Is

Claudia is the most popular Claude Code GUI — a native desktop application (macOS, Windows, Linux via Tauri) that provides a graphical interface for Claude Code sessions. It's the "IDE wrapper" model: Claude Code runs underneath, Claudia provides the UI layer.

Not an agent platform in the autonomOS sense — it doesn't schedule or orchestrate agents. It's a **session management and observability tool** for interactive Claude Code use. But several of its features are directly applicable to autonomOS's dashboard.

---

## Architecture

```
┌─────────────────────────────────────┐
│  Claudia (Tauri + React)            │
│                                     │
│  ┌─────────┐  ┌───────────────────┐ │
│  │ Session │  │ Custom Agent      │ │
│  │ Manager │  │ Configs (SQLite)  │ │
│  └────┬────┘  └───────────────────┘ │
│       │ IPC                         │
└───────┼─────────────────────────────┘
        │
        ▼ spawns
claude-code CLI process
```

Tauri's IPC bridge connects the React UI to a Rust backend that manages Claude Code child processes.

---

## Key Features

### Session Checkpoints + Branching

The headline feature. Claudia saves the full conversation state at any point as a "checkpoint." You can:
- Restore to any checkpoint (undo a bad agent decision)
- **Branch** from a checkpoint — start two divergent conversations from the same point

This is git-like branching for AI sessions. Implemented by copying Claude Code's JSONL session files.

```
Session history:
  A → B → C → D (current)
              ↓ checkpoint
              E (branch)
              A → B → C → E → F
```

### Custom Agents (SQLite-backed)

Claudia stores custom agent configurations in SQLite. Each agent has:
- Name, description
- System prompt override
- Allowed tools list
- Model selection (sonnet/opus/haiku)
- Default working directory

These are reusable presets — select "Code Reviewer" and it opens a session with the right system prompt and tool restrictions. Not scheduled/automated, but the definition model is similar to what autonomOS needs.

### Session Management

- Multi-session: run multiple Claude Code instances simultaneously
- Visual session list with status indicators
- Quick-switch between sessions
- Kill / restart individual sessions

### Usage Tracking

- Token count per session
- Cost estimation (API usage)
- Session duration
- Historical usage charts

### Project Detection

Detects git repositories in the working directory and shows project metadata alongside the session.

---

## What Makes It Interesting

1. **Checkpoint/branch model** — git-style versioning for conversations is the right abstraction for semi-autonomous agents. When an agent goes down a wrong path, you want to roll back without losing the good work.

2. **SQLite for agent configs** — simple, local, queryable. No filesystem gymnastics for agent definitions.

3. **Tauri architecture** — native app with web frontend. Fast, no Electron overhead. The pattern is directly applicable if autonomOS ever ships a desktop app.

4. **20.8k stars** — this is the dominant tool in the space. Users want: GUI, session management, checkpoints. autonomOS should deliver the web equivalent of this.

5. **Usage/cost tracking** — users care about this. Token cost per session is important UX.

---

## Weaknesses

- **Interactive only** — no scheduling, no automation. Purely for human-in-the-loop sessions.
- **Desktop app** — requires installation. Not accessible remotely (unlike a web dashboard).
- **Claude Code specific** — doesn't work with Agent SDK or other runners.
- **No inter-agent communication** — single-session focus.
- **SQLite agent configs** — not version-controlled, not composable. Can't git-diff your agents.

---

## Relevance to autonomOS

| Concept | Claudia | autonomOS |
|---------|---------|-----------|
| Agent definition | SQLite rows (GUI-created) | Folder with YAML + CLAUDE.md |
| Session management | Multi-session process management | Scheduler + AgentRuntime |
| Checkpointing | JSONL file copy | TBD — not in v1 scope |
| Usage tracking | Token count + cost | Should be in dashboard |
| UI layer | Tauri (native) | React web dashboard |
| Access | Local desktop only | Web + remote |

### Key borrowings

- **Checkpoint concept** — even without full branching, showing "session snapshots" in the dashboard would be valuable. `state/` folder versioning (git-tracked) is a lightweight equivalent.
- **Usage tracking UI** — token count per session + estimated cost per agent run. Essential for a responsible agent platform.
- **Multi-session panel** — the UX of showing multiple running sessions side-by-side with status indicators is well-validated by Claudia's popularity.
- **Project/workspace detection** — autonomOS should auto-detect git repos in agent working directories and surface them in the dashboard.

### What we do differently

- **Folder-based agent definitions** — version-controllable, composable, shareable. Better than SQLite rows.
- **Scheduling and automation** — Claudia is interactive-only. autonomOS is headless-first.
- **Web-based** — accessible remotely, no installation.
