# cmux Analysis — Competitive Research

**Researched:** 2026-03-23
**Source:** https://github.com/manaflow-ai/cmux
**GitHub stats:** 9,774 stars, 664 forks (as of research date)
**License:** AGPL-3.0
**Created:** January 2026

---

## Summary

cmux is a **native macOS terminal application** built specifically for developers running multiple AI coding agents (Claude Code, Codex, Gemini, OpenCode) in parallel. It is built with Swift/AppKit on top of libghostty (the rendering engine behind the Ghostty terminal), and reads existing `~/.config/ghostty/config` for themes and fonts.

The core thesis is that cmux is a **primitive, not a solution** — it provides composable building blocks (terminal, browser, notifications, workspaces, splits, CLI) and lets developers build their own agent workflows on top. It explicitly avoids being prescriptive.

**The problem it solves:** When running many Claude Code sessions in parallel, stock terminals have terrible multi-agent UX — no contextual notifications, no agent-aware sidebar metadata, and no integrated browser for agents to interact with your dev server.

---

## What cmux Does

### Core Features

**1. Agent-aware sidebar with vertical tabs**
Each workspace tab shows:
- Git branch
- Linked PR status/number
- Working directory
- Listening ports (auto-detected)
- Latest notification text
- Unread notification badge (blue dot)

**2. Notification system**
- Blue ring appears on panes when agents need attention
- Reads OSC 9/99/777 terminal sequences natively
- `cmux notify` CLI — wire into Claude Code/OpenCode/Codex hooks
- Notification panel (Cmd+I) aggregates all pending notifications
- `Cmd+Shift+U` jumps to most recent unread across all workspaces
- Menu bar extra with unread badge on app icon

**3. In-app browser**
- Split a browser pane alongside any terminal
- Full agent automation API ported from vercel-labs/agent-browser
- Agents can: snapshot accessibility tree, get element refs, click, fill forms, eval JS, take screenshots
- WKWebView-backed (Safari engine, not Chromium)
- Scriptable via CLI and socket API
- Supports tabs, state save/load, cookies, storage, console, dev tools

**4. Workspaces + splits**
- Horizontal and vertical splits
- Drag-and-drop tab reorder within panes and across panes
- Multi-window support (Cmd+Shift+N)
- Session restore: layout, working directories, scrollback, browser history

**5. Full CLI and socket API**
- `cmux` binary for scripting everything
- Unix socket API (v1 + v2 JSON protocol)
- Create workspaces, split panes, send keystrokes, open browser URLs
- Agent-scoped via `CMUX_WORKSPACE_ID` env var (planned — currently focused workspace)
- Short handle refs: `surface:N`, `pane:N`, `workspace:N`, `window:N`

**6. Remote SSH workspaces** (in progress)
- `cmux ssh` creates remote workspaces
- `cmuxd-remote` daemon bootstrapped over SSH
- Transport proxy planned (SOCKS5 + HTTP CONNECT)

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | Swift + AppKit |
| Terminal rendering | libghostty (C library from Ghostty) |
| Browser | WKWebView (Safari/WebKit) |
| CLI | Swift executable |
| Socket API | Unix domain socket, JSON protocol (v1 + v2) |
| Distribution | DMG, Homebrew cask, auto-update via Sparkle |
| Platform | macOS only |
| Package manager | Bun (for web components) + Swift Package Manager |

---

## Detailed Feature Comparison

| Feature | cmux | autonomOS |
|---------|------|-----------|
| **Platform** | macOS native app (Swift/AppKit) | Web app (Node server + React dashboard) |
| **Terminal rendering** | libghostty (GPU-accelerated, C) | xterm.js 6 + WebGL (TypeScript) |
| **Multi-agent support** | Yes — workspaces, vertical tabs | Yes — sessions, project browser |
| **Session persistence** | Layout + scrollback (not process state) | Full session pin + PM2 auto-resume |
| **Notifications** | Yes — OSC sequences, blue rings, panel | Not yet (planned: ADR-019) |
| **Agent hooks integration** | `cmux notify` CLI for hooks | Not yet (hook telemetry planned) |
| **Integrated browser** | Yes — WKWebView + full agent API | No |
| **Browser agent automation** | Yes — accessibility tree, click, fill, eval | No |
| **CLI control** | Yes — full scriptable API | No |
| **Socket API** | Yes — v2 JSON protocol | No |
| **PR/branch visibility** | Yes — sidebar shows branch + PR status | Planned (ADR-019, session enrichment) |
| **Listening ports** | Yes — auto-detected in sidebar | No |
| **Split panes** | Yes — horizontal + vertical | Yes (recently shipped, PR #43) |
| **Drag to reorder** | Yes — tabs + cross-pane | Yes — sidebar sessions |
| **Multi-window** | Yes | No |
| **Remote SSH** | In progress | No |
| **Themes** | Inherits from Ghostty config | Midnight, Daylight, Void (3 built-in) |
| **Provider support** | UI-agnostic (spawn anything in terminals) | Claude Code first, provider abstraction planned (ADR-014) |
| **Orchestrator / PM agent** | No | Planned (ADR-012) |
| **Project model** | No (workspaces only) | Planned (logical projects spanning repos) |
| **Cost tracking** | No | Planned (ADR-019) |
| **Usage/rate limits** | No | Yes — Claude Usage plugin |
| **Markdown preview** | No | Yes — Ctrl+click .md links, Mermaid |
| **Settings panel** | Yes | Yes |
| **Auth** | No | Optional token auth |
| **Remote deployment** | No (local only) | Yes — `make deploy` rsync + PM2 |
| **Mobile access** | iOS app (early access/paid) | Yes — responsive web, works on phone |
| **Web-accessible** | No | Yes — any browser |
| **Open source** | Yes (AGPL-3.0) | TBD |
| **Cross-platform** | macOS only | Any platform with Node.js |

---

## Architectural Comparison

### cmux Architecture

```
[Claude Code process]  [Codex process]  [Gemini process]
        |                    |                  |
        |      (PTY in macOS process)           |
        +------------------------------------+
                            |
                     [cmux macOS app]
                     Swift / AppKit
                            |
              +-------------+-------------+
              |             |             |
       [libghostty]   [WKWebView]   [cmux socket]
       (terminal       (browser)     (Unix socket)
        rendering)                       |
                                   [cmux CLI]
                                   (automation)
```

cmux wraps the OS's native PTY infrastructure. Each workspace is a real PTY. The sidebar and notification system are Swift overlays reading OSC sequences from terminal output. There is no intermediate server — the app IS the orchestrator.

### autonomOS Architecture

```
[Claude Code process]  [Codex process]  [Gemini process]
        |                    |                  |
        |          (node-pty via server)        |
        +------------------------------------+
                            |
                   [autonomOS server]
                   Hono + Node.js / Bun
                            |
              +-------------+-------------+
              |             |             |
         [WebSocket]    [REST API]   [Agent SDK]
         (PTY stream)   (sessions)   (discovery)
              |
       [React Dashboard]
       xterm.js + Zustand
```

autonomOS adds a network layer. The server manages PTYs and exposes them over WebSocket, enabling web access from any device. The dashboard is a React SPA that connects to the server. This is the key architectural trade-off: web accessibility vs native performance.

### Key Architectural Differences

| Dimension | cmux | autonomOS |
|-----------|------|-----------|
| **Deployment model** | Single native binary, macOS only | Server + web client, platform-agnostic |
| **Terminal spawning** | macOS native PTY | node-pty (Node.js binding) |
| **UI rendering** | libghostty (GPU, C) | xterm.js WebGL (browser) |
| **Remote access** | Not supported (SSH in progress) | Built-in (it's a web server) |
| **Agent automation** | Via CLI + socket | Planned (hooks, fork+query) |
| **Multi-device** | No (planned iOS app) | Yes (any browser) |
| **Performance ceiling** | Higher (native C rendering) | Lower (WebGL in browser) |
| **Extensibility** | CLI + socket API | Plugin system + REST API |

---

## What cmux Does Better

### 1. Notification system
cmux's notification UX is genuinely excellent for agent workflows. OSC sequence detection + visual rings on panes + a unified notification panel + jump-to-unread shortcut is the right design. autonomOS has this in the roadmap (ADR-019) but hasn't shipped it yet.

**Key insight:** The `cmux notify` CLI hook pattern is exactly what autonomOS needs — a way to wire Claude Code's PostToolUse/Stop hooks into the dashboard so you know when an agent is waiting without staring at every terminal.

### 2. Integrated browser with agent automation API
The vercel-labs/agent-browser port is a significant differentiator. Agents can interact with your dev server directly from within the workspace. This closes a real gap — currently you have to manually open a browser, navigate, interact, and paste results back. cmux agents can do this themselves.

### 3. Sidebar metadata density
Showing git branch + PR status + working directory + listening ports + notification text in a single vertical tab row is information-dense and genuinely useful. autonomOS's sidebar shows session name and status but lacks this contextual metadata.

### 4. Native performance
libghostty is C-level GPU rendering. It's faster and more memory-efficient than xterm.js/WebGL for heavy terminal workloads (large output, rapid scrolling). For the terminal-intensive workload of coding agents, this matters.

### 5. CLI + socket API
`cmux notify` is a concrete, shippable hook integration. autonomOS talks about hook telemetry but hasn't shipped a CLI or socket API. cmux's scripting surface lets power users build workflows today.

### 6. Workspaces as the mental model
cmux's "workspace" concept (one agent, one workspace, one sidebar entry) maps cleanly to how people think about parallel agent work. autonomOS mixes "sessions" (live PTYs) and "projects" (repo-level groupings) which creates cognitive overhead.

---

## What autonomOS Does Better

### 1. Web-first = multi-device
This is a genuine architectural advantage. You can approve a Claude Code tool call from your phone while in a meeting. You can monitor agents from a remote server via SSH tunnel or Tailscale. cmux is macOS-only and requires you to be at your desk.

### 2. Session persistence and auto-resume
autonomOS's PM2 daemon + pinned sessions survive server restarts and auto-reconnect. cmux restores layout but does NOT restore process state — if you restart cmux, your active Claude Code sessions are gone and need to be manually resumed.

### 3. Orchestrator vision
cmux is explicitly a primitive. It doesn't try to coordinate agents, track projects, or be a PM layer. autonomOS's ADR-012 lays out an orchestrator-first vision: a PM agent that understands projects, delegates to workspace agents, and tracks progress. This is meaningfully differentiated.

### 4. Provider abstraction
ADR-014's CLIProvider interface gives autonomOS a clean path to support Claude Code, Gemini CLI, and Codex with per-provider session discovery, autonomous mode mapping, and usage tracking. cmux sidesteps this by being provider-agnostic at the UI layer (you just spawn whatever you want in a terminal) — simpler but you lose provider-specific features.

### 5. Cost and usage tracking
The Claude Usage plugin (rate limits) and planned cost tracking plugin (per-session token costs, dollar amounts) are genuinely useful features. cmux has no equivalent.

### 6. Plugin system
autonomOS's VSCode-style plugin architecture (ADR-013) enables extensible observability features without coupling them to core. cmux has no plugin concept — features are built into the app.

### 7. Cross-platform deployment
Running autonomOS on a remote Linux server and accessing it from anywhere is a real workflow. cmux is macOS-only with no server deployment story.

---

## What autonomOS Can Learn from cmux

### High Priority

**1. Notification system — ship it now**
cmux validates that agent notifications are table stakes for a good agent orchestration UX. autonomOS's ADR-019 notification plan is correct in concept. The `notify()` API + toast + history panel needs to ship. The specific pattern to copy:
- Claude Code hook integration via a simple HTTP endpoint agents can POST to
- Visual badge/ring on the session card when an agent is waiting
- Keyboard shortcut to jump to the most recent unread session
- Notification panel aggregating all unread items

The simplest possible implementation: add `POST /api/notify` that takes `{ message, sessionId }` and lights up the session card. Wire into Claude Code's Stop hook in 30 seconds.

**2. Sidebar metadata density**
Add more contextual metadata to autonomOS session cards:
- Current git branch (readable from CWD via `git branch --show-current`)
- Linked PR number + status (planned in ADR-019 but should be prioritized)
- Detected listening ports (simple: use `lsof -i -P -n` filtered by process tree)
- Last notification/status text

**3. Agent hook wiring documentation + CLI**
Ship a `cmux notify`-equivalent. Something like:
```bash
# In Claude Code's Stop hook (hooks/Stop.sh):
curl -s -X POST http://localhost:3100/api/notify \
  -H "Content-Type: application/json" \
  -d "{\"message\": \"Waiting for input\", \"sessionId\": \"$CLAUDE_SESSION_ID\"}"
```
Document this pattern explicitly. It's the highest-leverage feature for daily use.

**4. Integrated browser / preview pane**
cmux's in-app browser with agent automation API is compelling. autonomOS already has a `/preview` route for markdown. The logical next step is a split browser pane where:
- Users can open a URL alongside any terminal
- (Future) agents can interact with the browser via an automation API
The vercel-labs/agent-browser API spec is open and documented.

### Medium Priority

**5. Workspace naming clarity**
cmux shows that "workspace" as the per-agent concept (one agent, one sidebar entry) is intuitive. autonomOS uses "session" for this. The ADR-012 rename (Projects → Workspaces for repo-level) creates a collision. Consider: autonomOS "sessions" = cmux "workspaces". May be worth aligning the mental model.

**6. Listening port detection**
Auto-detecting which ports each agent's process tree is listening on. Low-cost, high-value for showing in session cards.

### Lower Priority

**7. Multi-window / pop-out sessions**
cmux supports multiple windows. autonomOS is single-browser-tab. Allowing sessions to be popped out to new browser tabs would be low-cost since the dashboard is already web-accessible.

---

## Recommended Roadmap Additions

Based on this analysis, the following additions to autonomOS's roadmap are recommended in priority order:

### Add to "Now" milestone:

1. **Hook notification endpoint** (`POST /api/notify`) — agents POST from hooks, badge appears on session card. ~1-2 days. Immediately improves daily use.

2. **Git branch in session cards** — read `git branch --show-current` from session CWD. Low effort, high signal.

### Add to "Next" milestone:

3. **Notification system** (ADR-019 already planned) — prioritize over other ADR-019 items. The badge + panel + jump shortcut is the minimum viable feature.

4. **PR/branch visibility in sidebar** (ADR-019 already planned) — already in plan, cmux validates this is worth shipping sooner.

5. **Listening port detection** — lsof-based, show detected ports in session card.

### Add to "Later" milestone:

6. **Split browser pane** — not just markdown preview, but a full browser panel alongside terminals. Start with simple URL navigation, extend with agent automation API later.

7. **autonomOS notify CLI** — small shell script or binary agents can call from hooks. Wraps the HTTP endpoint above.

---

## Competitive Position

### The fundamental product bets are different

cmux bets that the best agent UX is a **native primitive** — fast, composable, developer-defined workflows. It explicitly says "cmux is not prescriptive." The right developer figures out their own workflow.

autonomOS bets that the best agent UX is an **intelligent orchestrator** — a PM agent that understands your projects and coordinates work across agents. It's prescriptive by design.

These are not mutually exclusive. A sophisticated autonomOS user running the orchestrator might still use cmux as their terminal. But in terms of product direction, autonomOS should double down on what cmux explicitly does not do: orchestration, project-level coordination, and intelligent agent management.

### Where cmux beats autonomOS today
- Notification UX (the single most important daily-use feature for multi-agent workflows)
- Native terminal performance (libghostty vs xterm.js)
- Sidebar metadata density (branch, PR, ports, notification text)
- Integrated browser with agent automation API
- CLI + socket automation API

### Where autonomOS beats cmux today
- Multi-device access (web-first, no macOS requirement)
- Session persistence and auto-resume across restarts
- Cost and usage tracking
- Plugin extensibility
- Deployable to remote servers

### Where autonomOS will beat cmux (if roadmap executes)
- Orchestrator layer — PM agent that coordinates across workspaces
- Project model — logical goals spanning multiple repos
- Structured agent observability (traces, activity, diagnostics)
- Cross-platform (Linux servers, Docker deployments)
- Hook telemetry for real-time agent state

### The notification gap is the most urgent convergence point
cmux is at 9,774 stars ~2 months after launch. A significant part of its appeal is the notification UX — the one workflow pain point it solves better than anything else. autonomOS needs to close this gap quickly. It's already in the plan (ADR-019); it needs to be prioritized to the top of the queue.

---

## References

- GitHub: https://github.com/manaflow-ai/cmux
- Website: https://cmux.com
- Docs: https://cmux.com/docs/getting-started
- Blog post: https://cmux.com/blog/zen-of-cmux
- Demo video: https://www.youtube.com/watch?v=i-WxO5YUTOs
- Discord: https://discord.gg/xsgFEVrWCZ
- agent-browser (ported to cmux): https://github.com/vercel-labs/agent-browser
