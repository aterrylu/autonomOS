# Overstory

**By:** Jaymin West (jayminwest)
**License:** MIT
**Language:** TypeScript/Bun
**Repo:** https://github.com/jayminwest/overstory
**Stars:** ~1,100
**Version:** 0.9.3

---

## What It Is

Overstory is a CLI tool that turns a single Claude Code session into a coordinated multi-agent swarm. Your CC session IS the orchestrator — no separate daemon. Hooks + SQLite + git worktrees + tmux do all the coordination. Part of the [os-eco](https://github.com/jayminwest/os-eco) ecosystem.

---

## 4-Layer Hierarchy

```
Orchestrator  (multi-repo coordinator — read-only)
    └── Coordinator  (persistent at project root — read-only)
            └── Supervisor/Lead  (team lead, depth 1 — read-write)
                    └── Scout / Builder / Reviewer / Merger  (workers, depth 2)
```

Agent definitions are markdown files in `agents/` directory — `coordinator.md`, `builder.md`, `scout.md`, etc. Per-task overlays written to worktrees via `ov sling`.

Depth limit configurable (default 2) — prevents runaway spawning.

---

## SQLite WAL Mail System

Location: `.overstory/mail.db`

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'status',
  priority TEXT NOT NULL DEFAULT 'normal',
  thread_id TEXT,
  payload TEXT,  -- JSON for protocol messages
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
```

WAL mode gives ~1-5ms per query with concurrent readers. 13 message types: `status`, `question`, `result`, `error`, `worker_done`, `merge_ready`, `merged`, `merge_failed`, `escalation`, `health_check`, `dispatch`, `assign`, `decision_gate`.

Broadcast via group addresses (`@all`, `@builders`). Polling via `ov mail check --inject` on UserPromptSubmit hook.

---

## 11 Runtime Adapters

The `AgentRuntime` interface abstracts over: Claude Code, Codex, Pi, Copilot, Cursor, Gemini, Sapling, OpenCode, Aider, Goose, Amp.

Key methods: `buildSpawnCommand`, `deployConfig`, `detectReady`, `parseTranscript`, `buildEnv`.

Guard mechanisms vary by runtime — CC uses `settings.local.json` hooks, Codex uses OS sandbox.

---

## 3-Tier Watchdog

1. **Mechanical daemon** — 30s interval, checks tmux/PID alive, progressive escalation (warn → nudge → triage → terminate)
2. **AI triage** — reads last 50 log lines, calls Claude to classify: retry/terminate/extend
3. **Monitor agent** — persistent CC agent running `monitor.md`, continuous fleet patrol

---

## 4-Tier Merge Conflict Resolution

1. **clean-merge** — `git merge` with no conflicts
2. **auto-resolve** — parse conflict markers, keep incoming changes
3. **ai-resolve** — Claude resolves remaining conflicts using conflict history
4. **reimagine** — abort and reimplement from scratch

---

## Dashboard (TUI)

Terminal UI only — **no web UI**. Pure ANSI escape codes via Chalk.

Layout:
```
Header bar (title, version, time)
Agent Panel (state icon, name, capability, runtime, task ID, duration, live indicator)
Feed (live events) | Tasks (tracker issues)
Mail (recent messages) | Merge Queue (entries with status)
Metrics strip (total sessions, avg duration, by-capability)
```

**Critical limitation:** No hierarchy visualization. Flat sorted list (active → completed → zombie). No tree view, no parent→child, no company structure. Read-only — no interactive control.

---

## Relevance to autonomOS

**What Overstory has that we don't:**
- SQLite WAL mail system with typed protocol messages
- 11 runtime adapters with clean abstraction
- 3-tier watchdog with AI triage
- 4-tier merge conflict resolution
- Agent definitions as markdown files

**What Overstory doesn't have (our opportunity):**
- No web UI — terminal TUI only
- No hierarchy visualization — flat list
- No company structure view
- No interactive control from dashboard
- No multi-machine support
- No cross-session messaging (uses filesystem only)

autonomOS's web dashboard + gateway + cross-machine reach fills exactly the gaps Overstory leaves open.

---

Sources:
- [GitHub - jayminwest/overstory](https://github.com/jayminwest/overstory)
- [Jaymin West - Agentic Engineering Book](https://jayminwest.com/agentic-engineering-book)
