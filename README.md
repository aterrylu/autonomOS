# autonomOS

A mission control platform for autonomous agents — spawn, observe, and coordinate Claude Code sessions from a web dashboard.

## What is this?

autonomOS is a **terminal dashboard for managing AI agents**. It spawns Claude Code sessions as PTY subprocesses, provides real-time observability via hook telemetry, and enables multi-agent coordination through a URI-based messaging gateway.

### What's Built

- **Split-pane terminals** — multiple Claude Code sessions side by side, drag-to-split, keyboard shortcuts (Ctrl+D/Shift+D/W/B)
- **Agent status tracking** — real-time status icons (working/idle/needs input/error) derived from Claude Code hook events
- **Session management** — create, resume, kill, auto-reconnect, output replay, auto-persist across server restarts
- **Auto-trust** — automatically dismisses Claude Code's startup trust prompts for frictionless session launch
- **Notification badges** — unread count per agent from SendUserMessage/Stop/Notification events, auto-clear when focused
- **Multi-agent messaging** — URI-based gateway (`agent://name`, `broadcast://all`) with MCP tools: `send`, `list_agents`, `create_agent`, `kill_agent`
- **Cron scheduler** — native timer-based scheduling (Croner v10) with 6 MCP tools, REST API, dashboard Schedules pane. Agents create schedules; two execution modes: `isolated` (headless `claude -p`) and `agent:<name>` (gateway delivery). Overlap policies, concurrency limits, one-time schedules, startup catch-up
- **Hook relay** — zero-config telemetry via `--settings` inline curl, 13 Claude Code hook events
- **Markdown preview** — Ctrl+click `.md` links in terminal, live-updating with mermaid diagram support
- **Plugin system** — VSCode-style status bar (Claude usage tracking built-in)
- **Settings panel** — API keys, channels, auto-trust toggle, Anthropic API override
- **PWA** — installable as standalone app with desktop notifications
- **Themes** — Midnight, Daylight, Void

### Architecture

```
Dashboard (React)          Server (Hono + node-pty)
┌─────────────┐           ┌──────────────────────┐
│ xterm.js    │◄──ws──────│ PTY sessions         │
│ Split panes │           │ Hook relay           │
│ Sidebar     │◄──poll────│ Agent status machine │
│ Schedules   │           │ MCP server (HTTP)    │
│ Status bar  │           │ Gateway router       │
└─────────────┘           │ Channel server (MCP) │
                          │ Cron scheduler       │
                          └──────────────────────┘
```

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
| `make deploy` | Rsync to remote + `make prod` (set `DEPLOY_HOST` in `.env`) |
| `make check` | Lint (Biome) + typecheck (tsc) + server tests |
| `make fmt` | Auto-fix lint + formatting issues |
| `make stop` | Stop PM2 daemon |
| `make logs` | Tail PM2 logs (last 50 lines) |
| `make down` | Stop everything and kill all server processes |

### Authentication

Optional token-based auth. When `AUTONOMOS_TOKEN` is set, the dashboard shows a login page and all API/WebSocket endpoints require the token.

```env
AUTONOMOS_TOKEN=your-secure-token-here
```

Leave unset to disable auth entirely.

### Remote Deployment

```env
DEPLOY_HOST=your-server-hostname
# DEPLOY_PATH=~/autonomOS    # optional, defaults to ~/autonomOS
```

Run `make deploy` — rsyncs code, installs deps, builds, and starts PM2.

## Structure

```
packages/
  dashboard/    # React + Zustand + Tailwind — web UI
    src/layout/       # Binary tree split-pane system
    src/hooks/        # useTerminal (xterm.js + focus registry)
    src/components/   # Sidebar, PreviewPane, SessionPane, ConversationView
    src/plugins/      # Status bar plugins (claude-usage, settings)
  server/       # Hono + node-pty — API, WebSocket, PTY management
    src/gateway/      # URI-based message router + platform adapters
    src/channel-server/ # Standalone MCP subprocess (server:autonomos)
    src/mcp/          # Shared MCP tool definitions
    src/routes/       # REST + WebSocket endpoints
  core/         # Shared types (Session, Gateway, Parser)
docs/
  DECISIONS.md  # Architectural decisions (append-only)
  FEATURES.md   # Feature specifications (F-001 through F-016)
  ROADMAP.md    # Current priorities
  RESEARCH.md   # Research findings
  VISION.md     # Project vision
  research/     # Deep-dive research topics (20+ entries)
```

## Tech Stack

- **Frontend**: React 19, Zustand 5, Tailwind CSS 4, xterm.js 6, Mermaid, framer-motion, react-resizable-panels
- **Backend**: Hono, node-pty, Claude Agent SDK, MCP SDK (@modelcontextprotocol/sdk)
- **Tooling**: Bun, Biome, PM2, TypeScript project references

## Docs

- **[FEATURES.md](docs/FEATURES.md)** — Feature specifications and design intent
- **[ROADMAP.md](docs/ROADMAP.md)** — What's done, what's next
- **[DECISIONS.md](docs/DECISIONS.md)** — Architectural decision records
- **[RESEARCH.md](docs/RESEARCH.md)** — Competitor analysis and research
- **[VISION.md](docs/VISION.md)** — Project vision
- **[setup/channels.md](docs/setup/channels.md)** — Telegram & Discord channel setup

## License

TBD
