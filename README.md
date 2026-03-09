# autonomOS

An orchestrator agent for autonomous development — manage projects, coordinate agents across workspaces, and observe everything from one place.

## What is this?

autonomOS is an **agent that manages agents**. The main interface is a PM-style orchestrator that understands your projects, delegates tasks to workspace agents (Claude Code sessions), and tracks progress across repositories.

### Core Concepts

- **Orchestrator** — The PM agent. Your main interface. It understands project goals, delegates work, and coordinates across workspaces.
- **Projects** — Logical goals with roadmaps. A project can span multiple workspaces (e.g., "Add auth" touches `api` + `dashboard` repos). Multiple projects can live under the same workspace.
- **Workspaces** — Physical repositories, auto-discovered from your machine. Each workspace can have active agent sessions running in it.

### What's Built

- **Terminal-first** — Claude Code sessions in high-quality embedded terminals (xterm.js)
- **Workspace browser** — all your Claude Code sessions grouped by repository via the Agent SDK
- **Session management** — create, switch, resume, kill, auto-reconnect with output replay
- **Observability** — see what your agents are doing across workspaces
- **Themes** — Midnight, Daylight, Void (Pitch Black)

## Quick Start

```bash
# Install dependencies + build node-pty native addon
make setup       # or: bun install

# Dev mode (Vite HMR + API server + Tailscale sidecar)
make up

# Prod mode (built dashboard served from API server)
make up MODE=prod

# Stop everything
make down
```

### Tailscale Setup

autonomOS runs on your machine and is exposed as `http://autonomos` on your tailnet via a Docker sidecar.

1. Copy `.env.example` → `.env`
2. Add your Tailscale OAuth key (see `.env.example` for instructions)
3. `make up` — the sidecar creates a dedicated Tailscale node

### Without Tailscale

Just run the server directly:

```bash
cd packages/server && npx tsx src/index.ts        # API only
cd packages/server && npx tsx watch src/index.ts   # API with watch
cd packages/dashboard && bun vite                  # Dashboard with HMR
```

## Structure

```
packages/
  dashboard/    # React + Zustand + Tailwind — web UI
  server/       # Hono + node-pty — API, WebSocket, PTY management
  core/         # Shared types
deploy/
  docker-compose.yml   # Tailscale sidecar
docs/
  DECISIONS.md  # Architectural decisions (append-only)
  ROADMAP.md    # Current priorities
  RESEARCH.md   # Research findings
```

## Tech Stack

- **Frontend**: React 19, Zustand, Tailwind CSS 4, xterm.js
- **Backend**: Hono, node-pty, Claude Agent SDK
- **Infra**: Tailscale sidecar, Docker Compose
- **Tooling**: Bun, Biome, TypeScript project references

## Docs

- **[ROADMAP.md](docs/ROADMAP.md)** — What's done, what's next
- **[DECISIONS.md](docs/DECISIONS.md)** — Architectural decision records
- **[RESEARCH.md](docs/RESEARCH.md)** — Competitor analysis and research

## License

TBD
