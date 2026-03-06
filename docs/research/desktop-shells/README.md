# Desktop Shell Decision — Research Synthesis

**Date:** 2026-03-06
**Status:** Research complete. Decision pending.
**Blocker for:** F-001 (Desktop Application Shell) which blocks all other features.

## The Question

What kind of application is autonomOS? This determines the tech stack, UX ceiling, distribution model, and development velocity for the entire project.

## Four Options Investigated

| Option | Research Doc | Reference Apps Studied |
|--------|------------|----------------------|
| **A. Electron (VSCode-style)** | [vscode-electron.md](vscode-electron.md) | VSCode, Cursor, Windsurf |
| **B. Electron (thin wrapper)** | [lm-studio.md](lm-studio.md), [zo-desktop.md](zo-desktop.md) | LM Studio, Zo Computer |
| **C. Tauri** | [vscode-electron.md](vscode-electron.md) (section 8) | YepAnywhere |
| **D. Pure Terminal / TUI** | [terminal-tui.md](terminal-tui.md) | k9s, lazygit, amux, neovim |

Also considered: web-only (no desktop app) — covered in [ui-architecture-options.md](../ui-architecture-options.md).

---

## Side-by-Side Comparison

### Fundamentals

| Factor | Electron | Tauri | Pure TUI | Hybrid (TUI + Web) |
|--------|----------|-------|----------|-------------------|
| Binary size | ~200-500 MB | ~10 MB | ~5-20 MB | ~5-20 MB + web |
| RAM baseline | ~300 MB | ~30-40 MB | <50 MB | <50 MB + browser |
| Startup | 1-2 sec | <0.5 sec | Instant | Instant |
| Distribution | DMG/installer | DMG/installer | `brew install` | `brew install` |
| macOS native feel | Good (with effort) | Good (native webview) | N/A (in terminal) | N/A |
| SSH / remote access | No | No | Yes | Yes (TUI), No (web) |

### Terminal Integration (Our Core Feature)

| Factor | Electron | Tauri | Pure TUI | Hybrid |
|--------|----------|-------|----------|--------|
| Terminal emulator | xterm.js + node-pty (gold standard) | xterm.js + portable-pty (less proven) | IS the terminal (tmux) | IS the terminal |
| Claude Code spawn | node-pty in same runtime (trivial) | Rust subprocess or sidecar | tmux send-keys | tmux send-keys |
| Multiple sessions | PTY Host manages pool | Same via sidecar | tmux windows/panes | tmux windows/panes |
| Session data extraction | Parse stream-json from subprocess | Same | Screen-scrape pane output (fragile) | Screen-scrape + daemon API |
| Permission handling | Native dialog or inline UI | Same | Inline text prompt | Inline text (TUI) or web modal |

### UX Capabilities

| Capability | Electron | Tauri | Pure TUI | Hybrid |
|-----------|----------|-------|----------|--------|
| Cost charts / analytics | Full (Recharts, D3) | Full | Sparklines only | Full (web) + sparklines (TUI) |
| Rich diffs / syntax highlighting | Full | Full | Terminal colors only | Full (web) + terminal (TUI) |
| Images / screenshots | Full | Full | Kitty protocol (limited) | Full (web) |
| System notifications | Native | Native | Terminal bell only | Via web push or native |
| Multi-monitor | Multiple windows | Multiple windows | Single terminal | TUI + browser windows |
| Markdown rendering | Full HTML | Full HTML | Glow (text-only) | Full (web) + Glow (TUI) |
| Forms / configuration | Full web forms | Full web forms | Awkward TUI forms | Full (web) |
| Session replay | Rich (code diffs, timeline) | Rich | Basic (text scroll) | Rich (web) |

### Development

| Factor | Electron | Tauri | Pure TUI (Go) | Pure TUI (TS) | Hybrid |
|--------|----------|-------|-------------|--------------|--------|
| Primary language | TypeScript | TypeScript + Rust | Go | TypeScript (Ink) | TypeScript + Go or Rust |
| Dev speed for v0 | Medium | Medium-slow (Rust) | Fast | Fast | Medium |
| Ecosystem maturity | Massive | Growing | Large (Bubble Tea) | Limited (Ink) | Mixed |
| Frontend framework | React/Svelte | React/Svelte | Bubble Tea | Ink (React) | Both |
| Build complexity | Medium (electron-builder) | Medium (Rust toolchain) | Low (go build) | Low (npm) | Medium |

---

## Key Discoveries

### 1. amux Already Exists

**[amux](https://github.com/mixpeek/amux)** is a single 12k-line Python file that manages dozens of parallel Claude Code agents via tmux, with a web dashboard, kanban board, REST API, and self-healing watchdog. This is essentially a working prototype of the tmux-based autonomOS.

Implications:
- The tmux + daemon + web dashboard pattern is proven
- The question is whether autonomOS is "a better amux" or "something fundamentally different"

### 2. Claude Code Already Uses tmux

Claude Code's Agent Teams feature uses tmux for multi-session management. Each teammate gets its own tmux pane. This means tmux is already the de facto platform for managing multiple Claude Code sessions.

### 3. LM Studio's Architecture Pattern

LM Studio separated the GUI from the backend (`llmster` daemon). The Electron shell is a thin client using the same APIs that external tools use. This "eat your own dog food" pattern applies regardless of which shell we choose.

### 4. VSCode's PTY Host Pattern

VSCode isolates terminal management in a separate PTY Host process. This is the proven architecture for managing multiple terminal sessions in Electron. Directly applicable.

### 5. Zo's Desktop App Is Just a Web Wrapper

Zo Computer's Electron app is essentially a browser window with file sync. 505 MB, performance issues. A cautionary tale for "web app in Electron" without deeper native integration.

### 6. Ink Is Claude Code's Own Framework

Claude Code is built with Ink (React for CLIs). This is interesting for ecosystem alignment but Ink is designed for CLI tools, not full-screen dashboards. It would limit the TUI to a simpler interface (which may be fine if the web dashboard handles complex views).

---

## Three Viable Architectures

After eliminating clearly inferior options (VSCode fork, Zellij plugin, pure web-only), three architectures remain viable:

### Architecture A: Electron App

```
Electron Main Process
    |
    +-- PTY Host (node-pty x N Claude sessions)
    |
    +-- Renderer (React + xterm.js + dashboard panels)
    |
    +-- Session Broker (SQLite, scanner, scheduler)
```

**Best for:** Richest possible UX. Full charts, diffs, images, notifications. Single integrated experience.
**Worst for:** Resource usage, SSH access, distribution simplicity.

### Architecture B: Hybrid TUI + Web

```
autonomOS Daemon (always running)
    |
    +-- Local API (HTTP + WebSocket)
    |
    +-- TUI (daily driver: session status, switching, monitoring)
    |       +-- tmux integration (Claude Code sessions)
    |
    +-- Web Dashboard (analytics: charts, replay, config)
            +-- Served at localhost, opened via browser
```

**Best for:** Terminal-native workflow, SSH access, low resource usage, composability. Rich analytics via web when needed.
**Worst for:** Split experience (two interfaces). No system notifications from TUI. No integrated feel.

### Architecture C: Electron with TUI Escape Hatch

```
Electron App (primary)
    |
    +-- PTY Host + xterm.js terminals
    +-- React dashboard panels
    +-- Session broker + SQLite
    |
    +-- Also exposes local API
         +-- CLI tool (`autonomos status`, `autonomos sessions`)
         +-- SSH-friendly access to same data
```

**Best for:** Best of both worlds. Rich desktop app AND CLI access.
**Worst for:** Highest development cost. Two interfaces to maintain.

---

## Decision Factors — What Matters Most for autonomOS

Ranked by importance to the project:

### 1. Terminal Quality (P0)

The embedded terminal / Claude Code session experience must be excellent. This is 80% of what users will interact with.

- **Electron:** xterm.js + node-pty. Gold standard. VSCode proves it.
- **Hybrid:** tmux IS the terminal. Users are already in their preferred terminal.
- **Winner:** Tie. Electron's terminal is great. But tmux gives users THEIR terminal (Ghostty, iTerm2, Kitty) with THEIR config.

### 2. Session Management (P0)

Spawning, switching between, and monitoring multiple Claude Code sessions.

- **Electron:** Tabs + panels in one window. Clean, integrated.
- **Hybrid:** tmux windows + TUI dashboard. Proven by amux + Claude Code Agent Teams.
- **Winner:** Tie. Different UX patterns, both work.

### 3. Cost Analytics (P1)

Visualizing spend over time, per-model breakdowns, trends.

- **Electron:** Full charting (Recharts, D3). Interactive, zoomable.
- **Hybrid:** Web dashboard for charts. Same quality, just in a browser tab.
- **Winner:** Tie. Both get full web-quality charts.

### 4. Development Speed (P0)

How fast can we ship v0?

- **Electron:** Medium. Electron boilerplate, IPC wiring, PTY Host setup.
- **Hybrid:** Fast for Phase 0 (CLI + tmux). Medium for TUI dashboard. Medium for web dashboard.
- **Winner:** Hybrid. Phase 0 (CLI + tmux) ships fastest with immediate value.

### 5. SSH / Remote Access

Managing agents on remote servers.

- **Electron:** No. Can't SSH into an Electron app.
- **Hybrid:** Yes. The TUI works over SSH. This is a real use case.
- **Winner:** Hybrid, clearly.

### 6. System Integration (notifications, tray, dock)

Knowing when an agent needs attention without looking at the app.

- **Electron:** Native notifications, dock badge, system tray. First-class.
- **Hybrid:** Terminal bell. Or web push notifications. Second-class.
- **Winner:** Electron.

### 7. Ecosystem Alignment

Sharing code, types, and patterns with Claude Code and OpenClaw.

- **Electron:** TypeScript everywhere. Shares runtime with Claude Code.
- **Hybrid:** Daemon is TypeScript. TUI could be Go (Bubble Tea) or TypeScript (Ink). Web is TypeScript.
- **Winner:** Tie if TUI uses Ink. Electron if TUI uses Go/Rust.

### 8. Future Robot Path

Camera feeds, sensor data, 3D visualization.

- **Electron:** Can embed anything a browser can render (Three.js, WebRTC video).
- **Hybrid:** Web dashboard handles this. TUI cannot.
- **Winner:** Tie. Both get there via web rendering.

---

## The Real Question

This isn't "which technology is best." It's **"what kind of product is autonomOS?"**

**If autonomOS is an app you open:** Electron. It's a destination. You launch it, use it, close it. Like VSCode or LM Studio.

**If autonomOS is infrastructure that's always running:** Hybrid. The daemon runs in the background. You dip in via terminal when you need it, open the web dashboard when you need charts. It's part of your environment, not a separate app. Like tmux or a local dev server.

**If autonomOS is both:** Architecture C (Electron + CLI). Most expensive to build, most flexible.

---

## Research Documents

| Document | What It Covers |
|----------|---------------|
| [vscode-electron.md](vscode-electron.md) | Electron architecture, process model, xterm.js + node-pty terminal integration, sandbox migration, IPC mechanisms, forks (Cursor, Windsurf), Tauri comparison, minimum viable Electron setup |
| [lm-studio.md](lm-studio.md) | Electron + React/Next.js, daemon separation pattern (`llmster`), "eat your own API" design, progressive disclosure UX, modular runtime updates |
| [zo-desktop.md](zo-desktop.md) | Electron + electron-builder, thin web wrapper approach, 505 MB binary, file sync as native addition, user feedback on performance |
| [terminal-tui.md](terminal-tui.md) | TUI framework landscape (Ratatui, Bubble Tea, Ink, Textual), tmux as platform, reference apps (k9s, lazygit, amux), capabilities assessment, hybrid approaches, amux deep dive |
| [../ui-architecture-options.md](../ui-architecture-options.md) | Original 4-option analysis (VSCode ext, web SPA, web+Tauri, terminal), comparison matrix, layered architecture recommendation |
