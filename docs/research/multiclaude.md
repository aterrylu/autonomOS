# multiclaude

**By:** Independent / community
**License:** MIT
**Language:** Go
**Repo:** https://github.com/NorbertNader/multiclaude (or equivalent)
**Focus:** Radical simplicity — many Claude sessions via files + tmux

---

## What It Is

multiclaude is a Go tool for running multiple Claude Code sessions simultaneously, coordinated through the filesystem. No databases, no message queues, no orchestration frameworks — just files, tmux, and shell scripts. It embodies what the author calls the **"Brownian Ratchet"** philosophy.

---

## The Brownian Ratchet Philosophy

Named after the Feynman Lectures concept: you don't need to know *where* a particle will go next — you just need to ensure it can't go backwards. Applied to agents:

> "Don't orchestrate the agents. Just ensure they can't undo progress."

The filesystem is the ratchet:
- Every completed step writes output to a file
- Agents read inputs from files, write outputs to files
- Progress is automatically preserved because file writes are durable
- No agent can "forget" work because it's on disk

This is the simplest possible multi-agent architecture. No framework needed.

---

## Architecture

```
~/.multiclaude/
├── tasks/
│   ├── task-001/
│   │   ├── input.md      # what the agent should do
│   │   ├── output.md     # agent writes results here
│   │   └── status        # "pending" | "running" | "done" | "error"
│   └── task-002/
│       └── ...
├── agents/
│   └── worker.md         # system prompt for all workers
└── queue               # list of pending task IDs
```

**tmux sessions** — each Claude Code instance runs in a separate tmux window. multiclaude creates and manages these windows programmatically via `tmux new-window`.

**Go coordinator** — small Go binary that:
1. Watches the `tasks/` directory for new tasks
2. Assigns tasks to idle Claude sessions
3. Monitors `status` files to detect completion
4. Writes new tasks from orchestrator output

No API. No WebSocket. Just `inotify` / `fsevents` + file I/O.

---

## Task Execution Flow

```
1. Coordinator writes task-003/input.md
2. Coordinator sets task-003/status = "pending"
3. Coordinator finds idle Claude session (tmux window)
4. Coordinator pastes prompt into tmux: "Read ~/task-003/input.md and write output to ~/task-003/output.md"
5. Claude session does work
6. Claude writes task-003/output.md
7. Claude writes task-003/status = "done"
8. Coordinator detects status change, picks up output
```

That's the entire protocol. No RPC. No message queues. File writes.

---

## Agent Definition

Just a markdown file (the system prompt). Minimal YAML if needed for metadata:
```yaml
# agent.yaml
name: code-worker
prompt_file: worker.md
count: 3    # spawn 3 instances
```

No scheduling concept — tasks are push-based from the coordinator.

---

## What Makes It Interesting

1. **File system as message bus** — the simplest possible IPC. Works across machines (with a shared filesystem), survives crashes (files are durable), and is debuggable with `ls` and `cat`.

2. **tmux as process manager** — avoids all process management complexity. tmux already handles session persistence, crash recovery, and human visibility (you can attach and watch).

3. **Brownian Ratchet** — the philosophy is legitimately useful. autonomOS should adopt this framing for `state/` files. State is the ratchet; agents just push forward.

4. **Go binary** — fast, single static binary, easy to install. No Node.js runtime needed for the coordinator.

5. **No auth, no API** — personal tool that doesn't pretend to be infrastructure.

---

## Weaknesses

- **tmux dependency** — not everyone runs tmux. Not accessible remotely without tmux attach.
- **File polling** — `inotify`-based watching has latency and can miss events under load.
- **No UI** — entirely terminal-based. You must `cat` files to see agent output.
- **Not web-native** — can't embed in a dashboard without significant wrapping.
- **Fragile task protocol** — writing to specific paths is an implicit contract. Easy to break.
- **No parallelism control** — coordinator spawns tasks as fast as possible. No rate limiting, no backpressure.

---

## Relevance to autonomOS

| Concept | multiclaude | autonomOS |
|---------|-------------|-----------|
| State storage | Files in `tasks/` | `state/` folder per agent |
| Process management | tmux sessions | Agent SDK sessions |
| Inter-agent comms | Files | Punted |
| Coordination | Go binary watching files | autonomOS server (Node.js) |
| UI | None (terminal only) | React dashboard |
| Agent definition | Minimal YAML + .md | `agent.yaml` + `.claude/CLAUDE.md` |

### Key borrowings

- **Brownian Ratchet** as design principle — state files are the ratchet. Agents don't need to remember what they've done because the `state/` folder can't go backwards. Adopt this framing in documentation.

- **Task input/output pattern** — for agents that need to exchange data, file-based I/O is the simplest starting point. An orchestrator agent can write task files; worker agents consume them. This is already supported by the `state/` folder design.

- **Human observability** — multiclaude's tmux approach means you can always `cat` a file to see what an agent is doing. autonomOS equivalent: the dashboard should always show raw agent output, not just processed summaries.

- **Static binary distributor** — when autonomOS eventually ships, a Go or Rust binary for the coordination layer (separate from the Node.js server) would make installation simpler.
