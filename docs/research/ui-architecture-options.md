# UI Architecture Options for autonomOS

**Date:** 2026-03-05
**Status:** Under consideration (pre-ADR)
**Context:** Deciding the tech stack for autonomOS's primary interface layer

## Background

Studied four reference projects that each chose different UI architectures:

| Project | UI Approach | Stack | License |
|---------|------------|-------|---------|
| CC-Insights | Desktop app (macOS) | Flutter/Dart | GPLv3 |
| DimensionalOS | CLI/terminal | Python SDK | Apache 2.0 |
| Mission Control | Web app | Next.js + SQLite | MIT |
| YepAnywhere | Web + desktop + mobile | Hono + React + Tauri 2.x | MIT |

## Why CC-Insights Chose Flutter Desktop

1. **Subprocess control** -- spawns Claude CLI as child processes. Desktop = native process management, no server needed.
2. **In-process transport** -- `InProcessTransport` wraps sessions directly in memory. Zero serialization overhead.
3. **macOS-native UX** -- window management, drag-and-drop, clipboard, embedded terminal (`flutter_pty`).
4. **Single developer** -- Flutter lets one person write a rich desktop app without separate frontend + backend.

**Trade-off accepted:** No API surface, no web access, no mobile, no remote. Everything dies when you close the app. CC-Insights' own integration analysis calls this out as a weakness.

## The Four Options

### Option 1: VSCode Fork / Extension

```
+-----------------------------------------+
| VSCode (Electron)                       |
|  +----------+  +----------------------+ |
|  | Extension |  | Webview Panels       | |
|  | Host      |--| (React/Svelte)       | |
|  | (Node.js) |  | Dashboard, Sessions  | |
|  +----------+  +----------------------+ |
|       |                                  |
|       +-- Claude CLI subprocess          |
|       +-- File system access             |
|       +-- Terminal integration           |
+-----------------------------------------+
```

**Examples:** Cursor, Windsurf, Cline, Continue, Void

**Pros:**
- Zero context-switch -- already live in VSCode
- Terminal integration for free (spawn Claude sessions right there)
- Extension API gives file system, git, diagnostics, workspace awareness
- Webview panels can run full React/Svelte apps for dashboards
- Extension marketplace distribution

**Cons:**
- Extension API is sandboxed -- limited panel layouts, no custom window chrome
- Webview panels are isolated iframes; cross-panel communication requires message passing through the extension host
- Forking VSCode (Cursor-style) is a massive maintenance burden -- inherit all of Electron + VSCode
- No mobile story at all
- Dashboard not accessible remotely (e.g., from phone for tool approvals)

**Verdict:** Extension = good for lightweight integration. Fork = enormous scope creep (building a code editor, not a control plane). Best used as a supplementary integration, not primary interface.

### Option 2: Web-Based Dashboard (Server + SPA)

```
+----------------------+     +----------------------+
| Server (Node.js)     |     | Browser              |
|  +-- Session broker  |<--->|  +-- React/Svelte    |
|  +-- File watcher    | WS  |  +-- Dashboard panels|
|  +-- REST API        | SSE |  +-- Session viewer  |
|  +-- SQLite DB       |     |  +-- Tool approvals  |
|  +-- Claude subprocess     |                       |
+----------------------+     +----------------------+
```

**Examples:** Mission Control (Next.js + SQLite), YepAnywhere (Hono + React)

**Pros:**
- Maximum flexibility -- any browser, any device
- Server runs headless -- survives closing the browser
- API surface for free -- other tools can integrate
- Both MC and YepAnywhere validate this works well
- Mobile access for tool approvals (YepAnywhere's whole pitch)
- Easiest to share/deploy for others

**Cons:**
- Two codebases (server + client) unless using full-stack framework (Next.js, SvelteKit)
- No native OS integration (window management, menubar, notifications) without wrapping
- Slightly more latency for subprocess management (HTTP round-trip vs in-process)

**Verdict:** Most versatile. Validated by two reference projects. Strong default choice.

### Option 3: Web Dashboard Packaged as Mac Desktop App

```
+-----------------------------------------+
| Tauri / Electron Shell                  |
|  +----------------------------------+   |
|  | Same React/Svelte web app        |   |
|  | (served locally or embedded)     |   |
|  +----------------------------------+   |
|  + Native menubar, tray icon            |
|  + Push notifications                   |
|  + Keyboard shortcuts                   |
|  + Auto-update                          |
+-----------------------------------------+
         ^
         | localhost / IPC
         v
+-----------------------------------------+
| Server (same as Option 2)               |
+-----------------------------------------+
```

**Examples:** YepAnywhere (Tauri 2.x for desktop + mobile), Slack, Discord, Notion

**Pros:**
- Best of both worlds -- web-first, native when you want it
- Tauri is tiny (~5MB binary vs Electron's ~200MB)
- Native notifications, tray icon, global shortcuts
- Same codebase serves web AND desktop
- YepAnywhere already validates Tauri 2.x for this exact use case

**Cons:**
- Added build complexity (Tauri requires Rust toolchain)
- Maintaining two distribution channels (web + desktop)
- The "native" benefits are mostly quality-of-life, not architectural

**Verdict:** This is Option 2 with a native wrapper. Start with web, add Tauri later. Not a separate decision -- it's a future enhancement.

### Option 4: Pure Terminal + tmux

```
+-------------------------------------------------+
| tmux                                            |
|  +------------+ +------------+ +-------------+  |
|  | Agent 1    | | Agent 2    | | Dashboard   |  |
|  | (claude)   | | (claude)   | | (TUI: rich/ |  |
|  |            | |            | |  textual/   |  |
|  |            | |            | |  bubbletea) |  |
|  +------------+ +------------+ +-------------+  |
|  +--------------------------------------------+ |
|  | Control pane (autonomos CLI)               |  |
|  | > autonomos status                         |  |
|  | > autonomos sessions --watch               |  |
|  | > autonomos approve <session> <tool>       |  |
|  +--------------------------------------------+ |
+-------------------------------------------------+
```

**Examples:** DimensionalOS (CLI-first), lazygit, k9s, bottom (btm)

**Pros:**
- Zero context-switch -- already in the terminal
- SSH-friendly -- works on remote machines
- Composable -- pipe output, script interactions
- Fast iteration -- no build step for UI changes
- Fits existing tmux + terminal workflow
- Tools like `textual` (Python) or `bubbletea` (Go) make rich TUIs feasible

**Cons:**
- Limited visualization -- no charts, no complex layouts, no images
- No mobile story
- TUI frameworks are less mature than web frameworks
- Harder for others to adopt (terminal-native users only)
- Observability data (cost trends, session timelines, context utilization) benefits from graphical visualization

**Verdict:** Great as a CLI companion, not as the primary interface. The data autonomOS needs to display (cost trends, session timelines, context utilization) benefits heavily from graphical visualization.

## Comparison Matrix

| Criterion | VSCode Ext | VSCode Fork | Web SPA | Web + Tauri | Terminal/tmux |
|-----------|-----------|-------------|---------|-------------|---------------|
| Dev effort to MVP | Medium | Very High | Medium | Medium+Later | Low |
| Rich visualization | Medium | High | High | High | Low |
| Mobile/remote access | No | No | Yes | Yes | SSH only |
| API surface | No | No | Yes | Yes | Via server |
| Native OS integration | Via VSCode | Full | No | Yes | No |
| Terminal workflow fit | High | Medium | Low | Low | Very High |
| Subprocess management | Good | Good | Good | Good | Native |
| Multi-user / share | No | No | Yes | Yes | No |
| Maintenance burden | Low | Very High | Medium | Medium | Low |
| Future robot path | Poor | Poor | Good | Good | Limited |

## Recommended Architecture: Layered

Don't pick one interface -- build in layers so multiple interfaces can coexist:

```
+-----------------------------------------------------+
|                    Interfaces                        |
|  +----------+  +--------------+  +---------------+  |
|  | CLI/TUI  |  | Web Dashboard|  | Tauri Desktop |  |
|  | (day 1)  |  | (day 1)      |  | (later)       |  |
|  +----+-----+  +------+-------+  +-------+-------+  |
|       |               |                   |          |
+-------+---------------+-------------------+----------+
|              Session Broker (server)                 |
|  +----------+  +----------+  +--------------------+  |
|  | REST API |  | WebSocket|  | EventBus (SSE/WS)  |  |
|  +----------+  +----------+  +--------------------+  |
|  +----------+  +----------+  +--------------------+  |
|  | Spawner  |  | Scanner  |  | SQLite DB          |  |
|  | (SDK)    |  | (JSONL)  |  | (sessions, costs)  |  |
|  +----------+  +----------+  +--------------------+  |
+------------------------------------------------------+
|              Agent Backends                          |
|  Claude CLI  |  Codex  |  OpenClaw  |  DimOS (MCP)  |
+------------------------------------------------------+
```

The server is the real product. CLI and web dashboard are both clients.

### Suggested Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Server | Hono (Node.js) | YepAnywhere-validated, lightweight, fast. Alternative: SvelteKit for full-stack SSR. |
| Web Dashboard | SvelteKit or React + Vite | Svelte = less boilerplate, great for dashboards. React = larger ecosystem, more reference code from MC/YepAnywhere. |
| CLI | Node.js (commander + chalk) | Share types with `packages/core`. Same runtime as server. Alternative: `ink` for React-in-terminal TUI. |
| DB | SQLite (better-sqlite3) | Validated by MC. Zero ops. WAL mode for concurrent reads. |
| Real-time | WebSocket + SSE | WS for bidirectional (session control), SSE for broadcast (dashboard updates). |
| Desktop wrapper | Tauri 2.x (when ready) | Tiny binary, native feel, same web app. Add after web is solid. |

### Build Order

1. **`packages/core`** -- TypeScript types, `EventTransport` interface, `InsightsEvent` discriminated union (pattern from CC-Insights' sealed hierarchy)
2. **`packages/server`** -- Hono server with session scanner (MC pattern) + session spawner (CC-Insights/YepAnywhere pattern) + SQLite
3. **`packages/dashboard`** -- Web UI consuming the server's API. Start with session list + cost overview.
4. **CLI** -- `autonomos status`, `autonomos sessions`, `autonomos approve` -- thin wrappers around the same REST API
5. **Desktop** -- Tauri wrapper around the web dashboard (quality-of-life, not architectural)

### The Core Question

The options boil down to: **Is the primary interaction point the terminal or the browser?**

- **Terminal-first:** Build server + CLI, add web dashboard later. Use CLI for daily work, dashboard for analytics.
- **Browser-first:** Build server + web dashboard together (SvelteKit makes this easy). Add CLI for scripting.

Given the existing workflow (tmux, terminal-heavy, wt-plan CLI), terminal-first with a parallel web dashboard for visualization may be the best fit. The server is the core regardless.

## References

- [CC-Insights architecture](cc-insights/architecture.md) -- Flutter desktop, EventTransport pattern
- [CC-Insights integration analysis](cc-insights/autonomos-integration.md) -- patterns to adopt/adapt
- [Mission Control architecture](mission-control/architecture.md) -- Next.js monolith, SSE + WS dual-channel
- [YepAnywhere architecture](yepanywhere/architecture.md) -- Hono + React + Tauri, multi-provider
- [DimensionalOS](dimensionalOS/README.md) -- CLI/Python SDK, module graph
