# autonomOS

An orchestrator agent for autonomous development — manage projects, coordinate agents across workspaces, and observe everything from one place.

## What is this?

autonomOS is an **agent that manages agents**. The main interface is a PM-style orchestrator that understands your projects, delegates tasks to workspace agents (Claude Code sessions), and tracks progress across repositories.

### Core Concepts

- **Orchestrator** — The PM agent. Your main interface. It understands project goals, delegates work, and coordinates across workspaces.
- **Projects** — Logical goals with roadmaps. A project can span multiple workspaces (e.g., "Add auth" touches `api` + `dashboard` repos). Multiple projects can live under the same workspace.
- **Workspaces** — Physical repositories, auto-discovered from your machine. Each workspace can have active agent sessions running in it.

### What's Built

- **Terminal-first** — Claude Code sessions in high-quality embedded terminals (xterm.js 6, WebGL, synchronized output for flicker-free rendering)
- **Workspace browser** — all your Claude Code sessions grouped by repository via the Agent SDK
- **Session management** — create, switch, resume, kill, auto-reconnect with output replay, auto-persist across restarts
- **Markdown preview** — Ctrl+click `.md` links in terminal to preview with mermaid diagram support
- **Plugin system** — VSCode-style status bar with modular plugins (Claude usage tracking built-in)
- **Settings panel** — configure API keys and provider settings from the dashboard
- **Observability** — see what your agents are doing across workspaces
- **Themes** — Midnight, Daylight, Void (Pitch Black)

## Quick Start

```bash
cp -n .env.example .env  # Create .env if it doesn't exist (edit to configure)
bun install              # Install dependencies

make dev                 # Dev mode — API on :3101, Vite HMR on :5173
make prod                # Prod mode — build dashboard + PM2 daemon on :3100
make down                # Stop everything
```

### All Make Targets

| Target | Description |
|--------|-------------|
| `make dev` | Start API server (watch mode, :3101) + Vite HMR (:5173) |
| `make prod` | Build dashboard + start/restart PM2 daemon on :3100 |
| `make stop` | Stop PM2 daemon |
| `make restart` | Alias for `make prod` |
| `make logs` | Tail PM2 logs (last 50 lines) |
| `make check` | Lint (Biome) + typecheck (tsc) + tests |
| `make fmt` | Auto-fix lint + formatting issues |
| `make deploy` | Rsync to remote + `make prod` (set `DEPLOY_HOST` in `.env`) |
| `make down` | Stop everything and kill all server processes |

### Authentication

Optional token-based auth. When `AUTONOMOS_TOKEN` is set, the dashboard shows a login page and all API/WebSocket endpoints require the token.

1. Add to `.env`:
   ```
   AUTONOMOS_TOKEN=your-secure-token-here
   ```
2. Start the server — it will print `Auth enabled (token: your...here)`
3. Open the dashboard — enter the token on the login page
4. A session cookie is set (1-year expiration) — you won't need to re-enter it

Leave `AUTONOMOS_TOKEN` unset to disable auth entirely.

### Claude Usage Tracking

The status bar shows your Claude rate limits (5h rolling, 7d weekly, per-model breakdowns).

1. Go to [claude.ai](https://claude.ai)
2. Open DevTools → Application → Cookies → `.claude.ai`
3. Copy `sessionKey` and `lastActiveOrg` values (use the `.claude.ai` domain, not `anthropic.com`)
4. Add to `.env`:
   ```
   CLAUDE_SESSION_KEY=sk-ant-sid01-XXXX
   CLAUDE_ORG_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

### Remote Deployment

Deploy to a remote server via rsync:

1. Add to `.env`:
   ```
   DEPLOY_HOST=your-server-hostname
   # DEPLOY_PATH=~/autonomOS    # optional, defaults to ~/autonomOS
   ```
2. Run `make deploy` — rsyncs code, installs deps, builds, and starts PM2

## Structure

```
packages/
  dashboard/    # React + Zustand + Tailwind — web UI
  server/       # Hono + node-pty — API, WebSocket, PTY management
  core/         # Shared types and agent abstractions
docs/
  DECISIONS.md  # Architectural decisions (append-only)
  ROADMAP.md    # Current priorities
  RESEARCH.md   # Research findings
```

## Tech Stack

- **Frontend**: React 19, Zustand, Tailwind CSS 4, xterm.js 6, Mermaid
- **Backend**: Hono, node-pty, Claude Agent SDK, MCP SDK
- **Tooling**: Bun, Biome, PM2, TypeScript project references

## Docs

- **[ROADMAP.md](docs/ROADMAP.md)** — What's done, what's next
- **[DECISIONS.md](docs/DECISIONS.md)** — Architectural decision records
- **[RESEARCH.md](docs/RESEARCH.md)** — Competitor analysis and research

## License

TBD
