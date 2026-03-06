# Terminal / TUI Approaches for autonomOS

**Date**: 2026-03-06
**Purpose**: Evaluate whether autonomOS can be built as a pure terminal application instead of an Electron desktop app
**Status**: Complete

---

## Table of Contents

1. [TUI Frameworks -- The Landscape](#1-tui-frameworks----the-landscape)
2. [Terminal Multiplexers as a Platform](#2-terminal-multiplexers-as-a-platform)
3. [Reference Apps -- Terminal-Native Developer Tools](#3-reference-apps----terminal-native-developer-tools)
4. [The tmux-based Architecture](#4-the-tmux-based-architecture)
5. [Capabilities Assessment](#5-capabilities-assessment)
6. [Hybrid Approaches](#6-hybrid-approaches)
7. [The DimensionalOS Approach](#7-the-dimensionalos-approach)
8. [Honest Assessment](#8-honest-assessment)
9. [Recommendation](#9-recommendation)

---

## 1. TUI Frameworks -- The Landscape

### Rust

#### Ratatui

| Attribute | Details |
|-----------|---------|
| **URL** | [ratatui.rs](https://ratatui.rs/) / [GitHub](https://github.com/ratatui/ratatui) |
| **Stars** | 18.8k |
| **Used by** | 13.1k projects |
| **License** | MIT |
| **Maturity** | High -- forked from tui-rs in 2023, active development, modular workspace since 0.30.0 |
| **Architecture** | Immediate-mode rendering with multiple backend support (crossterm, termion, termwiz) |

**Features:**
- Sub-millisecond rendering with zero-cost abstractions
- Rich widget library: charts, sparklines, tables, gauges, scrollable lists, progress bars, tabs, scrollbars, block layouts
- Modular workspace structure (since 0.30.0) for better compilation times
- Multiple terminal backends
- Extensive ecosystem of third-party widgets and higher-level frameworks (tui-realm adds React/Elm-like state management)

**Notable apps built with Ratatui:**
- **bottom (btm)** -- cross-platform system monitor with charts and graphs
- **gitui** -- terminal Git client
- **kdash** -- Kubernetes dashboard
- **Yazi** -- blazing fast file manager
- **ATAC** -- full-featured API client
- **slumber** -- HTTP/REST client
- **oxker** -- Docker container manager
- **kubetui** -- Kubernetes resource monitor
- **spotify-player** -- full Spotify client with visualization
- **openapi-tui** -- browse and run OpenAPI endpoints
- **gitu** -- Magit-inspired Git TUI

**Limitations:**
- Rust learning curve; not the team's primary language
- Immediate-mode rendering means you manage all state yourself (no component model out of the box)
- No built-in async runtime -- you wire up tokio/async-std yourself
- No web fallback -- pure terminal only

**Relevance to autonomOS:** HIGH. The most mature and capable TUI framework available. If we went Rust, this is the clear choice. The kdash (Kubernetes dashboard) and bottom (system monitor) examples prove it can handle dashboard-style apps with charts, real-time updates, and multi-panel layouts.

---

#### Zellij (as a framework)

| Attribute | Details |
|-----------|---------|
| **URL** | [zellij.dev](https://zellij.dev/) / [GitHub](https://github.com/zellij-org/zellij) |
| **Stars** | ~22k |
| **License** | MIT |
| **Architecture** | Terminal multiplexer with WASM plugin system |

Covered in detail in [Section 2](#zellij-1).

---

### Go

#### Bubble Tea (charmbracelet/bubbletea)

| Attribute | Details |
|-----------|---------|
| **URL** | [GitHub](https://github.com/charmbracelet/bubbletea) |
| **Stars** | 40.3k |
| **Used by** | 18,000+ applications |
| **License** | MIT |
| **Maturity** | Very high -- v2 released with major improvements |
| **Architecture** | Elm Architecture (Model-Update-View) |

**Features:**
- Elm Architecture: `Init()`, `Update()`, `View()` -- clean, predictable state management
- v2 Cursed Renderer: ncurses-based, highly optimized for speed and accuracy
- Progressive keyboard enhancements (shift+enter, super+space, key release detection)
- Terminal mode 2026 (atomic updates, reduced tearing/flicker)
- Mode 2027 (proper wide Unicode and emoji handling)
- High-fidelity mouse support (click, release, wheel, motion -- separate message types)
- Native clipboard support, progress bar rendering
- Framerate-based rendering, focus reporting

**Ecosystem (Charm tools):**
- **Lip Gloss** -- styling library (colors, borders, padding)
- **Bubbles** -- pre-built components (text inputs, spinners, paginator, viewport, tables, file picker)
- **Huh?** -- form/survey toolkit
- **Glow** -- markdown reader
- **Mods** -- AI on the command line

**Notable adopters:**
- GitHub CLI (`gh-dash`)
- Microsoft Azure (Aztfy)
- CockroachDB
- AWS (eks-node-viewer)
- NVIDIA (container-canary)
- Ubuntu (Authd)
- chezmoi, Superfile

**Limitations:**
- Go language -- not TypeScript (different ecosystem from autonomOS's likely stack)
- Elm architecture can be verbose for complex UIs with many nested components
- No web fallback
- Single binary distribution is a plus, but Go's garbage collector can cause micro-pauses

**Relevance to autonomOS:** HIGH. The most popular TUI framework by GitHub stars. The Elm architecture is clean and battle-tested. lazygit and k9s prove Go TUIs can handle complex multi-panel developer tools. Enterprise adoption (GitHub, AWS, Microsoft) validates production readiness.

---

### TypeScript / Node.js

#### Ink

| Attribute | Details |
|-----------|---------|
| **URL** | [GitHub](https://github.com/vadimdemedes/ink) |
| **Stars** | 35.4k |
| **License** | MIT |
| **Architecture** | React renderer for terminals -- JSX-based |

**Features:**
- Full React feature support: hooks, state, context, effects
- Flexbox layout via Yoga engine
- Text styling (colors via chalk, bold, italic, underline, strikethrough)
- Text wrapping modes (wrap, truncate variants)
- Focus management (`useFocus`, `useFocusManager`)
- Keyboard input (`useInput` hook), clipboard (`usePaste`)
- Screen reader support
- React DevTools integration
- Components: `<Box>`, `<Text>`, `<Static>`, `<Transform>`, `<Newline>`, `<Spacer>`

**Notable apps built with Ink:**
- **Claude Code** (Anthropic) -- the very tool autonomOS manages
- **Gemini CLI** (Google)
- **GitHub Copilot CLI**
- **Cloudflare Wrangler**
- **Prisma CLI**
- **Gatsby CLI**
- **Linear CLI**
- **Shopify CLI**

**Limitations:**
- Not designed for full-screen, complex TUI layouts -- more suited to CLI tools with interactive elements
- Terminal size constraints can cause content overlap
- Limited to what Flexbox can express (no CSS Grid, no absolute positioning beyond basic)
- Node.js overhead vs compiled languages
- No built-in charting, table, or rich widget library (need third-party)
- React rendering in terminal is inherently slower than native terminal rendering

**Relevance to autonomOS:** CRITICAL. Ink is the framework Claude Code itself is built with. This means:
1. We already understand the mental model (React + JSX)
2. TypeScript ecosystem alignment
3. We could potentially share components or patterns with Claude Code
4. BUT -- Ink is best for CLI tools, not full-screen dashboards. Claude Code is a linear conversation interface, not a multi-panel dashboard.

---

#### Blessed / Neo-Blessed

| Attribute | Details |
|-----------|---------|
| **URL** | [GitHub (blessed)](https://github.com/chjj/blessed) / [GitHub (neo-blessed)](https://github.com/embarklabs/neo-blessed) |
| **Stars** | ~11k (blessed) |
| **License** | MIT |
| **Maturity** | Legacy -- original blessed unmaintained, multiple forks exist |

**Features:**
- Full ncurses reimplementation in JavaScript
- Rich widget set: windows, forms, lists, tables, text areas, progress bars, file managers
- Mouse support, scrolling, focus management
- Multiple fork ecosystem: neo-blessed (embarklabs), unblessed (TypeScript rewrite with 98.5% test coverage)

**Current state:**
- Original blessed is unmaintained
- Neo-blessed maintains bug fixes but limited new features
- **Unblessed** is a modern TypeScript rewrite (alpha, API stable) -- most promising fork

**Limitations:**
- Fragmented ecosystem -- multiple forks, unclear winner
- Original library architecture is dated
- Node.js performance limits for complex UIs
- No active community momentum

**Relevance to autonomOS:** LOW. While blessed was once the go-to Node.js TUI library and offers the richest widget set in the JS ecosystem, the fragmented state and lack of active development make it risky. Unblessed is worth watching but is alpha software.

---

### Python

#### Textual (Textualize)

| Attribute | Details |
|-----------|---------|
| **URL** | [textual.textualize.io](https://textual.textualize.io/) / [GitHub](https://github.com/Textualize/textual) |
| **Stars** | 34.6k |
| **License** | MIT |
| **Creator** | Will McGuire (creator of Rich) |
| **Maturity** | High -- active development, large community |

**Features:**
- CSS-like styling system (the closest to web development in any TUI framework)
- 16.7 million colors, smooth flicker-free animation
- Mouse support, scroll, focus management
- Extensive widget library: buttons, trees, data tables, inputs, text areas, list views, tabs, markdown viewers
- Flexible layout system (docking, grid)
- **Web serving via `textual serve`** -- run terminal apps in a web browser
- Development tools: debug console, event monitoring
- 250k+ PyPI downloads in Q1 2025

**Dual deployment:**
Textual's killer feature is that the same app runs both in the terminal AND in a web browser via `textual serve`. This is unique among TUI frameworks.

**Limitations:**
- Python -- different ecosystem from autonomOS (TypeScript)
- Python performance for real-time updates
- Web mode has its own rendering quirks
- Not suitable for embedding terminal sessions (it IS a terminal app, not a terminal manager)

**Relevance to autonomOS:** MEDIUM. The CSS styling and web-serving dual deployment model is inspiring. If autonomOS were Python-based, Textual would be the obvious choice. The "terminal app that also runs in a browser" concept is exactly the hybrid approach worth considering, even if we implement it differently.

---

### Framework Comparison Summary

| Framework | Language | Stars | Architecture | Full-Screen TUI | Web Fallback | Widgets | Best For |
|-----------|----------|-------|-------------|-----------------|-------------|---------|----------|
| **Ratatui** | Rust | 18.8k | Immediate-mode | Excellent | No | Rich (charts, tables, gauges) | Dashboards, system monitors |
| **Bubble Tea** | Go | 40.3k | Elm (MVU) | Excellent | No | Good (via Bubbles) | Developer tools, complex TUIs |
| **Ink** | TypeScript | 35.4k | React/JSX | Limited | No | Basic | CLI tools, interactive prompts |
| **Textual** | Python | 34.6k | CSS + widgets | Excellent | Yes (`textual serve`) | Rich | Full apps, dashboards |
| **Blessed** | Node.js | 11k | ncurses-like | Good | No | Rich but dated | Legacy projects |
| **Zellij plugins** | Rust/WASM | 22k | Event-driven | Within pane | No | Custom render | Extensions to Zellij |

**For a full-screen mission control dashboard**, the clear winners are **Ratatui** (Rust) and **Bubble Tea** (Go). Ink is a poor fit for full-screen dashboards despite being TypeScript. Textual is excellent but Python-only.

---

## 2. Terminal Multiplexers as a Platform

### tmux

| Attribute | Details |
|-----------|---------|
| **What** | Terminal multiplexer -- split terminal into sessions, windows, panes |
| **Language** | C |
| **License** | ISC (BSD-like) |
| **Maturity** | Extremely high -- decades of use, ubiquitous on Linux/macOS |

**Programmatic control:**
- `tmux` CLI commands for creating/managing sessions, windows, panes
- **Control mode** (`tmux -C`): machine-friendly stdin/stdout interface for event notifications and command execution
- **libtmux** (Python): typed OO API for driving tmux programmatically (powers tmuxp session manager)
- **tmuxp**: session manager with YAML/JSON config files for declaring layouts

**Key capabilities for autonomOS:**
- Create named sessions and windows for each Claude Code instance
- Split panes for dashboard + agent views
- Programmatically send keystrokes to panes (`tmux send-keys`)
- Capture pane output (`tmux capture-pane`)
- Switch between sessions/windows
- Resize panes
- **Control mode** allows building a controller that reacts to tmux events

**Already proven for Claude Code:**
- Claude Code's own Agent Teams feature uses tmux split panes (each teammate gets its own pane)
- **amux** (mixpeek/amux) manages dozens of parallel Claude Code agents via tmux -- a single 12k-line Python file with web dashboard, kanban board, and REST API
- **ittybitty** spawns Claude Code instances in tmux virtual terminals

**Limitations:**
- tmux panes are raw terminal output -- no structured data, no widgets
- Reading pane output requires ANSI parsing (amux does this)
- No native charting or rich UI within tmux itself
- Session management is string-based (fragile if not careful)
- macOS: requires `brew install tmux` (not pre-installed)

**Relevance to autonomOS:** CRITICAL. tmux is already the de facto platform for managing multiple Claude Code sessions. Claude Code's own agent teams use it. amux proves the pattern works at scale. The question is whether autonomOS should be a tmux orchestrator or something more.

---

### Zellij

| Attribute | Details |
|-----------|---------|
| **What** | Modern terminal multiplexer with WASM plugin system |
| **Language** | Rust |
| **License** | MIT |
| **Stars** | ~22k |
| **Plugin runtime** | wasmi v0.51 (migrated from wasmtime in v0.44.0) |

**WASM Plugin System:**
- Plugins run in sandboxed WASM environments
- Communication via Protocol Buffers
- Plugins can: render UI, respond to events, execute background tasks
- Any language that compiles to WASM (Rust has first-class SDK support)
- Isolated memory, controlled file I/O via wasmi_wasi
- Configurable resource limits

**Could autonomOS be a Zellij plugin?**
- Theoretically: a Zellij plugin could render a dashboard in one pane while other panes run Claude Code
- The plugin can subscribe to events, render custom UI, and execute commands
- Rust is the best-supported plugin language (official SDK and scaffolding)

**Limitations as a platform:**
- Much smaller user base than tmux
- Plugin API is still evolving (v0.12.0)
- WASM sandbox limits what plugins can do (network access is restricted)
- Not compatible with tmux -- it's a replacement, not a complement
- Claude Code's agent teams don't support Zellij (only tmux and iTerm2)
- TypeScript/JS cannot easily compile to WASM for this use case

**Relevance to autonomOS:** LOW-MEDIUM. Interesting architecture but premature. Claude Code doesn't support Zellij for agent teams, the plugin API is still maturing, and the WASM sandbox limits network-heavy operations that autonomOS needs (WebSocket to OpenClaw, HTTP to GitHub, etc.). Revisit if Zellij's plugin ecosystem matures.

---

### Screen

| Attribute | Details |
|-----------|---------|
| **What** | Original terminal multiplexer (GNU) |
| **Status** | Maintained but effectively superseded by tmux |

Screen is legacy. It lacks the programmatic control, modern features, and ecosystem that tmux provides. Not a viable platform for autonomOS.

---

### Multiplexer Comparison

| Feature | tmux | Zellij | Screen |
|---------|------|--------|--------|
| Programmatic control | Excellent (CLI, control mode, libtmux) | WASM plugins | Basic |
| Claude Code support | Native (agent teams) | None | None |
| Plugin system | Scripts + CLI | WASM (sandboxed) | None |
| Pane capture | Yes (`capture-pane`) | Via plugin API | Limited |
| Community tools | amux, tmuxp, sesh, ittybitty | Growing | Stagnant |
| Learning curve | Medium | Low (better defaults) | Low |
| macOS pre-installed | No (brew) | No (brew/cargo) | Yes |

---

## 3. Reference Apps -- Terminal-Native Developer Tools

### Neovim

**The gold standard for terminal-native developer tools.**

- Plugin ecosystem with Lua scripting (replaced VimScript)
- Floating windows, splits, tabs -- complex layout management within a terminal
- LSP integration, treesitter, telescope (fuzzy finding)
- Manages complexity through modal editing + command palette + plugin composition
- 40+ year lineage of vi/vim -- proves terminal UIs can be deeply powerful

**Lessons for autonomOS:**
- Modal interfaces work -- different modes for different tasks (observe vs configure vs interact)
- Plugin/extension architecture enables community contributions
- Keybinding-driven UX with discoverability (which-key shows available bindings)
- BUT: Neovim's complexity is legendary. The learning curve is steep. autonomOS needs to be immediately useful.

---

### lazygit

| Attribute | Details |
|-----------|---------|
| **Language** | Go (gocui library, not Bubble Tea) |
| **Stars** | ~55k |

**How it handles multi-panel layouts:**
- Fixed panel layout: files, branches, commits, stash -- always visible
- Panel-based navigation with tab/arrow keys
- Per-repository state management (`GuiRepoState` in `RepoStateMap`)
- Worktree support -- switch between repos while preserving UI state
- Real-time updates as git state changes
- Interactive rebasing, cherry-picking, conflict resolution inline

**Lessons for autonomOS:**
- Panel-based layout is natural for "mission control" -- each panel shows a different dimension (sessions, costs, status, logs)
- Single binary, zero dependencies, instant startup
- Keyboard-driven with mouse support as enhancement
- Proves complex Git operations can be more intuitive in a TUI than on the command line

---

### k9s

| Attribute | Details |
|-----------|---------|
| **Language** | Go |
| **Stars** | ~29k |
| **What** | Kubernetes dashboard in the terminal |

**The closest analog to what autonomOS would be as a TUI.**

k9s is literally "mission control for Kubernetes" in the terminal:
- Real-time monitoring with auto-refresh
- Multiple dashboards: Deployments, Pods, Metrics (CPU/memory), X-Ray (resource relationships)
- Context-aware navigation between namespaces and clusters
- Logs, scaling, port-forwards, restarts -- all inline
- Plugin support for custom commands
- 256-color terminal mode
- Keyboard-driven with search/filter

**Lessons for autonomOS:**
- A "mission control for infrastructure" absolutely works as a TUI -- k9s proves it
- Real-time dashboards with metrics are feasible in the terminal
- Resource-type navigation (pods -> deployments -> services) maps to our domain (sessions -> agents -> cron jobs)
- Plugin system enables extensibility without core changes

---

### bottom (btm)

| Attribute | Details |
|-----------|---------|
| **Language** | Rust (ratatui) |
| **What** | Cross-platform system monitor |

**Proves charts and graphs work in the terminal:**
- CPU usage charts with line graphs
- Memory usage with stacked area charts
- Network I/O graphs
- Process table with sorting and filtering
- Temperature monitoring
- Disk usage
- All with real-time updates and smooth rendering

**Lessons for autonomOS:** Cost charts, context utilization graphs, and token spend over time are all feasible as terminal charts using ratatui's chart widgets.

---

### Warp

| Attribute | Details |
|-----------|---------|
| **Language** | Rust |
| **What** | Modern terminal emulator with AI integration |

**Relevant innovations:**
- **Block-based output**: each command and its output is a discrete "block" that can be selected, copied, shared. This rethinks terminal UX fundamentally.
- **Modern input editor**: multi-line editing, syntax highlighting, completions
- **AI integration**: agents with full terminal control, BYOK support
- **Warp 2.0** (2026): "Agentic Development Environment" -- moved beyond terminal to full agent orchestration

**Lessons for autonomOS:**
- Warp proves the terminal can be reimagined without abandoning it
- Block-based output is relevant -- each Claude Code interaction could be a "block"
- BUT: Warp is a terminal emulator, not a TUI app. Building a new terminal emulator is orders of magnitude more complex than a TUI app.
- Warp eventually moved TOWARD desktop app features (AI agents, orchestration) -- the terminal wasn't enough

---

### Ghostty

| Attribute | Details |
|-----------|---------|
| **Language** | Zig |
| **What** | Fast, GPU-accelerated terminal emulator |
| **Stars** | Very high (top terminal emulator of 2025) |

**Key innovations:**
- Custom GPU rendering pipeline (Metal on macOS, OpenGL/Vulkan on Linux)
- Fastest terminal emulator benchmarked (0.7s for cat 100k lines)
- Platform-native UI (not Electron)
- MIT license, now under non-profit fiscal sponsorship

**Relevance to autonomOS:** Ghostty is relevant as the terminal our users likely run. A TUI autonomOS app would run inside Ghostty/Kitty/iTerm2/WezTerm. Understanding terminal capabilities (image protocols, GPU rendering, color support) matters for choosing what UX is possible.

Note: Ghostty does NOT support Kitty graphics protocol. Terminal choice affects what features are available.

---

### Claude Code Itself

**Claude Code is already a terminal app built with Ink (React for CLIs).**

Key observations:
- It uses React/JSX rendering via Ink
- Linear conversation interface (not multi-panel dashboard)
- Multi-surface architecture: same engine, different UIs (terminal, desktop, web, IDE)
- Agent Teams already use tmux for multi-session management
- Hooks + MCP are the integration surface

**What if autonomOS was a wrapper/multiplexer around Claude Code sessions?**
- This is essentially what amux already does
- autonomOS would add: structured dashboard, cost analytics, scheduling, history/search, git integration
- The key question: can those additions live in a TUI, or do they need a richer UI?

---

## 4. The tmux-based Architecture

This is the most concrete "terminal-native" architecture for autonomOS. Here's how it would work:

### Architecture

```
+------------------------------------------------------------------+
|  tmux session: "autonomos"                                        |
|                                                                    |
|  +---------------------------+  +-------------------------------+  |
|  |  Window 0: Dashboard      |  |  Window 1: Agent "frontend"   |  |
|  |  (TUI app -- ratatui/     |  |  (Claude Code session)        |  |
|  |   bubbletea)               |  |                               |  |
|  |                            |  |  $ claude                     |  |
|  |  [Sessions]  [Costs]       |  |  > Working on auth refactor.. |  |
|  |  frontend  ACTIVE  $2.31  |  |  > Reading src/auth/...       |  |
|  |  backend   IDLE    $0.45  |  |                               |  |
|  |  tests     RUNNING $1.02  |  |                               |  |
|  |                            |  |                               |  |
|  |  [Context]  [Schedule]     |  |                               |  |
|  |  ████████░░ 78%           |  |                               |  |
|  |  Next: cron@14:00         |  |                               |  |
|  +---------------------------+  +-------------------------------+  |
|                                                                    |
|  Window 2: Agent "backend"    Window 3: Agent "tests"              |
+------------------------------------------------------------------+
```

### Technical Implementation

1. **autonomOS daemon**: a background process that:
   - Manages tmux sessions/windows for each Claude Code agent
   - Polls/captures pane output to extract status (via ANSI parsing, like amux)
   - Connects to OpenClaw via WebSocket for structured data
   - Stores history, costs, metrics in local database (SQLite)
   - Exposes a local API (Unix socket or HTTP) for the dashboard

2. **autonomOS TUI dashboard**: a full-screen TUI app (Window 0) that:
   - Renders session status, cost charts, context utilization
   - Keyboard shortcuts to switch to agent windows (`1`, `2`, `3`...)
   - Search/filter sessions and history
   - Schedule management (view/edit cron jobs)
   - Connects to daemon via local API

3. **tmux as the session manager**:
   - `tmux new-session -s autonomos` -- create the session
   - `tmux new-window -t autonomos -n "frontend"` -- create agent window
   - `tmux send-keys -t autonomos:frontend "claude --resume session-id" Enter` -- start agent
   - `tmux capture-pane -t autonomos:frontend -p` -- read output
   - `tmux select-window -t autonomos:dashboard` -- switch to dashboard

### How status extraction works (the amux approach)

amux proves this is viable:
- Capture tmux pane output with `tmux capture-pane -p`
- Strip ANSI escape codes
- Parse for known patterns (Claude Code status indicators, cost output, etc.)
- Update dashboard state
- Polling interval: ~1-2 seconds

### Advantages of this architecture

- **Zero overhead**: no Electron, no Chromium, no web server for basic use
- **SSH-friendly**: manage agents on remote servers over SSH
- **Composable**: tmux sessions can be attached/detached, shared between terminals
- **Familiar**: developers already know tmux
- **Claude Code native**: agent teams already use tmux, so this aligns with the tool
- **Single binary + tmux**: minimal dependencies

### Disadvantages

- **Fragile status extraction**: parsing terminal output is brittle. Claude Code output format changes break parsing.
- **No structured API from Claude Code**: we're screen-scraping, not using a real API. This is the fundamental weakness.
- **Limited visualization**: charts in terminal are low-fidelity. Cost trends over weeks are hard to visualize.
- **No images/screenshots**: can't show diffs with syntax highlighting beyond terminal colors, can't show rendered markdown, can't display architecture diagrams.
- **Learning curve**: users need to know tmux basics (or we hide it, which defeats the purpose).
- **Pane management complexity**: layouts break when terminals are resized. Managing 10+ agent windows gets unwieldy.

---

## 5. Capabilities Assessment

| Capability | TUI Feasibility | Notes |
|-----------|----------------|-------|
| Multiple terminal sessions | Excellent | tmux handles this natively. Proven by amux, Claude Code agent teams. |
| Dashboard with status | Good | k9s, kdash prove infrastructure dashboards work in TUI. Tables, status indicators, progress bars all work. |
| Cost charts/graphs | Moderate | Terminal charts exist (ratatui sparklines, line charts) but are low-resolution. Good for trends, bad for detailed analysis. |
| Session switching | Excellent | tmux window/pane switching is instant. Keybinding-driven. |
| Rich text / markdown | Moderate | Glow (Charm) renders markdown in terminal. Limited formatting vs browser. No images in markdown. |
| File diffs | Good | delta, diff-so-fancy prove syntax-highlighted diffs work in terminal. lazygit shows them inline. |
| Search | Good | Fuzzy finding (telescope, fzf) is actually BETTER in terminal than most GUIs. |
| Mouse support | Good | Modern TUI frameworks support click, scroll, drag. Not expected by all terminal users though. |
| Images / screenshots | Poor | Requires Kitty/iTerm2/Sixel protocols. Not universally supported. Ghostty lacks Kitty graphics. |
| Permission dialogs | Moderate | Can show modal dialogs in TUI, but they're text-only. No native OS integration (no system tray, no notifications). |
| Split views | Good | Both tmux panes and TUI internal splits work. tmux is more robust for independent terminal processes. |
| Notifications | Poor | No system notifications. Can flash terminal, ring bell, but no banner notifications when terminal is backgrounded. |
| Agent scheduling UI | Moderate | Can display cron schedules in a table. Editing cron expressions in a TUI form is workable but not great. |
| Session history + search | Good | SQLite + full-text search displayed in TUI list/table. fzf-style filtering is excellent. |
| Cost analytics over time | Poor | Multi-week cost trends need proper line charts. Terminal charts are too low-resolution for meaningful analytics. |
| Real-time streaming output | Excellent | Terminals are literally built for this. |
| Git/worktree integration | Good | lazygit proves Git TUIs can be excellent. Branch visualization, diff viewing, commit history all work. |

---

## 6. Hybrid Approaches

### Option A: Terminal App + Web Dashboard

**Architecture:**
```
autonomOS daemon (always running)
    |
    +-- Local API (HTTP/Unix socket)
    |
    +-- TUI dashboard (daily driver -- ratatui/bubbletea)
    |       |-- Session status, switching, quick actions
    |       |-- Real-time agent monitoring
    |       |-- tmux integration for session management
    |
    +-- Web dashboard (analytics -- served at localhost:PORT)
            |-- Cost charts with proper visualization (d3/recharts)
            |-- Historical analytics, trends
            |-- Session replay
            |-- Architecture diagrams
```

**This is the strongest hybrid.** The TUI is the primary interface for daily use (fast, SSH-accessible, composable). The web dashboard opens in a browser for analytics and rich visualization that terminals can't do well.

Precedent: `gh` (GitHub CLI) opens browser for complex views. `kubectl` has web dashboards. Even k9s users often use Grafana for long-term metrics.

### Option B: tmux + Companion TUI

**Architecture:**
```
tmux session
    |
    +-- Window 0: autonomOS TUI (dashboard overlay)
    +-- Window 1-N: Claude Code sessions
    +-- Status bar: autonomOS status line in tmux status bar
```

The TUI is a tmux window alongside Claude Code windows. Custom tmux status bar shows aggregate info (active agents, total cost, alerts). This is essentially the amux approach with a native TUI instead of web dashboard.

### Option C: Terminal App That Can Open Browser

Like how `gh pr view --web` opens GitHub in a browser:
- `autonomos` launches TUI dashboard
- `autonomos costs --web` opens cost analytics in browser
- `autonomos session replay <id> --web` opens session replay in browser
- Complex views delegate to web, simple views stay in terminal

### Option D: Textual-Inspired Dual Deployment

Build the app once, run it in terminal OR browser:
- Textual (Python) already does this with `textual serve`
- Could we build a TypeScript equivalent? Harder -- no equivalent framework exists.
- Would require building our own terminal-to-web bridge

---

## 7. The DimensionalOS Approach

Based on our existing research (`docs/research/dimensionalOS/`), DimensionalOS is primarily a Python SDK with CLI tooling:

- **CLI-first**: developers interact via Python scripts and CLI commands
- **No TUI dashboard**: there's no terminal dashboard for monitoring robots
- **Prototype web terminal**: dimensionalOS.com/prototype shows a web-based terminal interface
- **Module graph is code-defined**: blueprints and module composition happen in Python code, not a UI
- **Visualization via external tools**: RViz (ROS), MuJoCo viewer for simulation -- external GUI tools, not built-in

**Lessons for autonomOS:**
- DimensionalOS chose "SDK + CLI" over "dashboard" for developer experience
- Complex state (module graphs, sensor streams) is managed in code, not visualized in real-time
- When visualization is needed, they use external tools (RViz, MuJoCo viewer)
- This suggests a TUI dashboard is not mandatory -- a good CLI + integration with external visualization tools could suffice
- BUT: DimensionalOS's use case (robotics development) is different from autonomOS's (agent monitoring). Monitoring is inherently more visual than development.

---

## 8. Honest Assessment

### What We Would GAIN with a TUI

1. **Perfect alignment with the tool**: autonomOS manages terminal sessions. Being terminal-native means zero context switching. You're already in the terminal where agents run.

2. **SSH access**: manage remote agents over SSH. No port forwarding, no VPN, no browser. This is huge for production/server use cases.

3. **Lower resource usage**: no Chromium process consuming 500MB+ RAM. A Go/Rust TUI uses <50MB.

4. **Composability**: pipe output, script interactions, integrate with shell workflows. `autonomos status | jq '.sessions[] | select(.cost > 5)'` -- Unix philosophy.

5. **Faster iteration**: TUI frameworks are simpler than Electron. No webpack, no CSS frameworks, no frontend build pipelines.

6. **Single binary distribution**: `brew install autonomos` or `cargo install autonomos`. No DMG, no app bundle, no auto-updater.

7. **Developer credibility**: terminal-native tools signal "built by developers, for developers." lazygit, k9s, neovim -- the tools developers love most are terminal-native.

### What We Would LOSE vs Electron

1. **Rich data visualization**: cost trends, token usage over time, context utilization history -- these need proper charts. Terminal sparklines are not enough for analytics.

2. **Images and rich media**: can't display screenshots, architecture diagrams, rendered markdown with images. Agent outputs that include visual content can't be shown.

3. **System integration**: no menu bar, no system tray, no native notifications, no dock badge. Users won't know when an agent needs attention unless they're looking at the terminal.

4. **Onboarding**: TUIs have a learning curve. New users won't know keybindings. Discoverability is worse than point-and-click GUIs.

5. **Complex forms**: editing agent configurations, cron expressions, or multi-field forms is awkward in a TUI. Web forms are better.

6. **Accessibility**: TUIs are worse for screen readers, high-contrast modes, and users with motor impairments who rely on mouse/touch.

7. **Multiple monitors**: can't have dashboard on one screen and agents on another easily (tmux is single-terminal). Electron windows can span monitors.

8. **Session replay**: replaying an agent's work (seeing what it did step by step) benefits from rich rendering -- syntax-highlighted code changes, file diffs, tool calls visualized. A TUI can do basic text replay but not rich replay.

### The Core Question: Is Terminal-Native Actually Better Here?

**Arguments for YES:**
- autonomOS manages terminal sessions. It should BE a terminal session.
- The users (developers running Claude Code) are already terminal-native.
- amux proves the pattern works -- a single Python file manages dozens of agents via tmux.
- The daily workflow is: glance at status, switch to an agent, interact, switch back. A TUI does this perfectly.
- SSH access for remote agents is a real requirement, not a theoretical benefit.

**Arguments for NO:**
- "Mission control" implies a dashboard with rich visualization. Think NASA mission control, not `htop`.
- Cost analytics (a key feature) needs proper charts. "How much did I spend this week across all agents?" needs a line chart, not a sparkline.
- autonomOS aspires to be more than a session switcher -- it wants scheduling, history, search, orchestration. These features benefit from GUI affordances.
- Claude Code itself is evolving beyond terminal (desktop app, web, IDE integration). autonomOS should meet users where they are.
- The robot path (future) will need camera feeds, sensor visualization, 3D views -- impossible in a terminal.

### The Day-to-Day Experience

**Morning routine with TUI autonomOS:**
1. Open terminal, `tmux attach -t autonomos` or `autonomos`
2. See dashboard: 3 agents idle, 1 scheduled for 9am, total cost yesterday $12.40
3. Press `1` to switch to frontend agent window
4. `claude --resume session-xyz` -- start working
5. Press `0` to glance at dashboard -- backend agent finished, 2 errors
6. Press `2` to check backend agent output
7. Press `0`, navigate to costs -- squint at sparkline chart... open browser for real analytics

**Morning routine with Electron autonomOS:**
1. Click autonomOS in dock
2. See dashboard: 3 agents idle, 1 scheduled, cost chart showing $12.40 yesterday ($47 this week, trending down)
3. Click "frontend" -- terminal panel opens within the app
4. Interact with Claude Code in the embedded terminal
5. Notification badge: "backend agent finished with 2 errors"
6. Click notification -- see error details with syntax-highlighted code diff
7. Click costs tab -- interactive chart with daily/weekly/monthly views

**Honest comparison:** The TUI version works for the "power user daily workflow" but falls short for analytics and discovery. The Electron version is smoother for the full feature set but adds overhead and removes SSH access.

---

## 9. Recommendation

### TL;DR

**Build a hybrid: TUI primary + web companion for analytics.**

autonomOS should NOT be a pure Electron app, and should NOT be a pure TUI. The right answer is:

1. **Core daemon** (TypeScript/Node.js or Go): background process that manages sessions, connects to OpenClaw, stores data, exposes local API
2. **TUI dashboard** (primary interface): for daily use -- session status, switching, quick actions, real-time monitoring
3. **Web dashboard** (companion): for analytics, cost visualization, session replay, configuration -- served locally by the daemon

### Recommended Architecture

```
                        +-------------------+
                        |  autonomOS daemon  |
                        |  (always running)  |
                        +--------+----------+
                                 |
                    Local API (HTTP + WebSocket)
                                 |
              +------------------+------------------+
              |                                     |
     +--------+--------+                  +---------+---------+
     |  TUI Dashboard   |                  |  Web Dashboard    |
     |  (daily driver)  |                  |  (analytics)      |
     |                  |                  |                    |
     |  Session status  |                  |  Cost charts      |
     |  Agent switching |                  |  Session replay   |
     |  Quick actions   |                  |  Config editor    |
     |  Real-time logs  |                  |  History search   |
     |  tmux integration|                  |  Trend analysis   |
     +------------------+                  +--------------------+
              |
     +--------+--------+
     |  tmux sessions   |
     |  Claude Code x N |
     +------------------+
```

### Framework Recommendation for TUI

**If TypeScript (ecosystem alignment with Claude Code/OpenClaw):**
- Use Ink for the TUI dashboard -- despite its limitations for full-screen apps, it aligns with the TypeScript ecosystem and Claude Code's own stack
- Accept that the TUI will be simpler (session list, status, switching) rather than a full charting dashboard
- Complex visualization goes to the web dashboard

**If willing to use Go (better TUI capabilities):**
- Use Bubble Tea -- the Elm architecture is clean, the ecosystem is rich, and k9s/lazygit prove Go TUIs handle complex developer tools well
- Single binary distribution, excellent performance
- The web dashboard is still TypeScript (React/Next.js)

**If willing to use Rust (best TUI capabilities, hardest to develop):**
- Use Ratatui -- the richest widget library, best charting, best performance
- bottom and kdash prove dashboard-style apps work beautifully
- Highest development cost, smallest team familiarity

### What NOT to Build

- **Do not build a terminal emulator** (like Warp). That's a multi-year, multi-person project.
- **Do not build a Zellij plugin**. The ecosystem is too immature and Claude Code doesn't support it.
- **Do not try to force Ink into a full-screen dashboard framework**. It's not designed for that. Keep the TUI simple if using Ink.
- **Do not go pure TUI with no web fallback**. Analytics and configuration UX will suffer.

### Phased Approach

| Phase | What | Why |
|-------|------|-----|
| **Phase 0** | CLI tool (`autonomos` command) + tmux session management | Get core value immediately -- spawn/manage/switch Claude Code sessions. No TUI framework needed. |
| **Phase 1** | Simple TUI dashboard (Ink or Bubble Tea) | Session list, status, cost summary, quick switching. Ship fast, validate the terminal-native workflow. |
| **Phase 2** | Web dashboard companion | Cost analytics, session replay, configuration UI. Serves on localhost, opened via `autonomos dashboard --web`. |
| **Phase 3** | Evaluate if desktop app is needed | If web dashboard + TUI covers 90% of needs, skip Electron entirely. If system integration (notifications, tray) is a real pain point, consider a lightweight wrapper (Tauri, not Electron). |

### Key Insight

The most important realization from this research: **amux already exists and works.** A single 12k-line Python file manages dozens of Claude Code agents via tmux with a web dashboard, kanban board, and REST API. autonomOS should study amux deeply and decide: are we building a better amux, or something fundamentally different?

If we're building a better amux: the hybrid TUI + web approach is correct, and we should start with Phase 0 (CLI + tmux).

If we're building something fundamentally different (agent orchestration platform, not just session management): the web dashboard or desktop app becomes the primary interface, and the TUI becomes a lightweight access point.

---

## Sources

### TUI Frameworks
- [Ratatui](https://ratatui.rs/) | [GitHub](https://github.com/ratatui/ratatui) | [Awesome Ratatui](https://github.com/ratatui/awesome-ratatui)
- [Bubble Tea](https://github.com/charmbracelet/bubbletea) | [Bubbles](https://github.com/charmbracelet/bubbles) | [v2 Discussion](https://github.com/charmbracelet/bubbletea/discussions/1374)
- [Ink](https://github.com/vadimdemedes/ink)
- [Textual](https://textual.textualize.io/) | [GitHub](https://github.com/Textualize/textual)
- [Blessed](https://github.com/chjj/blessed) | [Neo-blessed](https://github.com/embarklabs/neo-blessed)
- [Zellij](https://zellij.dev/) | [GitHub](https://github.com/zellij-org/zellij) | [Plugin System (DeepWiki)](https://deepwiki.com/zellij-org/zellij/4-keybindings-and-input-handling)

### Terminal Multiplexers
- [libtmux](https://github.com/tmux-python/libtmux) | [tmuxp](https://github.com/tmux-python/tmuxp)
- [tmux Control Mode](https://tmuxai.dev/tmux-control-mode/)
- [sesh](https://github.com/joshmedeski/sesh)
- [tmux vs Zellij Comparison (2026)](https://dasroot.net/posts/2026/02/terminal-multiplexers-tmux-vs-zellij-comparison/)

### Reference Apps
- [lazygit](https://github.com/jesseduffield/lazygit) | [DeepWiki](https://deepwiki.com/jesseduffield/lazygit)
- [k9s](https://k9scli.io/) | [GitHub](https://github.com/derailed/k9s)
- [bottom](https://github.com/ClementTsang/bottom)
- [Warp](https://www.warp.dev/) | [Warp 2.0 Blog](https://www.warp.dev/blog/reimagining-coding-agentic-development-environment)
- [Ghostty](https://github.com/ghostty-org/ghostty) | [Docs](https://ghostty.org/docs)

### Claude Code + tmux
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams)
- [amux](https://github.com/mixpeek/amux) | [amux.io](https://amux.io/)
- [Claude Code Multi-Agent tmux Setup](https://www.dariuszparys.com/claude-code-multi-agent-tmux-setup/)
- [Claude Code Internals: Terminal UI](https://kotrotsos.medium.com/claude-code-internals-part-11-terminal-ui-542fe17db016)

### Terminal Capabilities
- [Kitty Graphics Protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/)
- [Terminal Image Protocols (rasterm)](https://github.com/BourgeoisBear/rasterm)
- [Best Terminal Emulators 2026 (Scopir)](https://scopir.com/posts/best-terminal-emulators-developers-2026/)

### General
- [Back to the Terminal: The New Era of CLI and TUI Software](https://www.trickster.dev/post/back-to-the-terminal-the-new-era-of-cli-and-tui-software/)
- [CLI-First Agency: Why Claude Code Lives in Your Terminal](https://www.sitepoint.com/claude-code-cli-agent-review/)
- [Terminal Trove - TUI Tools](https://terminaltrove.com/categories/tui/)
