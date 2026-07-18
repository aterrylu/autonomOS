# Features

The canonical feature list for autonomOS. Each feature includes priority, status, and design notes.
Priorities shift as we learn — this is a living document, not a contract.

**Legend:**
- **P0** — Must have. Blocks everything else or defines the product.
- **P1** — High priority. Core experience, build soon after P0.
- **P2** — Medium priority. Important but can wait.
- **P3** — Low priority / punt. Want it eventually, not thinking about it now.

---

## Table of Contents

- [F-001: Desktop Application Shell](#f-001-desktop-application-shell)
- [F-002: Terminal View](#f-002-terminal-view)
- [F-003: Chat View](#f-003-chat-view)
- [F-004: Session Discovery & Management](#f-004-session-discovery--management)
- [F-005: Multi-Session Dashboard](#f-005-multi-session-dashboard)
- [F-006: Agent Scheduling & Automation](#f-006-agent-scheduling--automation)
- [F-007: Cost Tracking & Analytics](#f-007-cost-tracking--analytics)
- [F-008: Session History & Search](#f-008-session-history--search)
- [F-009: Git & Worktree Integration](#f-009-git--worktree-integration)
- [F-010: Provider Abstraction Layer](#f-010-provider-abstraction-layer)
- [F-011: File Browser](#f-011-file-browser)
- [F-012: Agent Profiles & Rules](#f-012-agent-profiles--rules)
- [F-013: Integrations Dashboard](#f-013-integrations-dashboard)
- [F-014: Mobile & Remote Access](#f-014-mobile--remote-access)
- [F-015: Web Hosting / Deploy](#f-015-web-hosting--deploy)
- [F-016: Real-Time Streaming](#f-016-real-time-streaming)

---

## F-001: Desktop Application Shell

**Priority:** P0
**Status:** Web-first shipped (ADR-005). Electron desktop path **cut** (ADR-051) — the canonical client is the browser + PWA (#71).
**Depends on:** Nothing (everything depends on this)

### What

The container that holds everything. The single most important architectural decision — determines tech stack, dev experience, distribution model, and what's possible for every other feature.

### Decision: Web-First (ADR-005); Electron path cut (ADR-051)

**Architecture:** A Bun server (Hono) that spawns and manages Claude Code subprocesses, serves a web dashboard, and exposes REST + WebSocket APIs. The client is the web dashboard — installable as a PWA (#71) — reached locally or against a remote always-on server. (An Electron desktop wrapper was built across ADR-005/028/029/030 and later **cut** in ADR-051; the web-first core below is what endured. The retained rationale documents why web-first won.)

**Stack (ADR-007, ADR-009):**
- **Runtime:** Bun (Anthropic-backed, Claude Code runs on it, uWebSockets C++ under the hood)
- **Server:** Hono (multi-runtime, 25K+ stars, native WebSocket/SSE, Cloudflare uses internally)
- **Language:** TypeScript everywhere (server, dashboard, core types — zero serialization layer)
- **Terminal:** xterm.js in browser, server-side PTY streamed over WebSocket
- **Data:** SQLite for v0 (abstract for future PostgreSQL swap)

**Why web-first:**
- Fastest path to v0 — no Electron boilerplate, IPC wiring, or native packaging
- The server IS the product — CLI, web dashboard, and PWA are all clients
- Mobile/remote access for free — approve tools from phone, check on agents remotely
- YepAnywhere and amux both validate web-first works for this exact use case
- LM Studio pattern: separate the backend daemon from the UI shell

**Why not Electron-first:**
- Adds boilerplate upfront with no mobile story
- The "real app" packaging can be added later — xterm.js + node-pty is not exclusive to Electron
- Zo Computer's 505 MB Electron wrapper is a cautionary tale

**Why not Tauri:**
- Rust PTY libs less proven than node-pty
- WebView inconsistencies across OS
- Good future option for lightweight packaging

**Why not pure TUI:**
- Cost analytics need real charts, session replay needs rich rendering
- amux proves the pattern: tmux for process management, web dashboard for the UI

**Key insight:** tmux, Electron, and web are all just process management + UI. The server that spawns Claude Code, parses events, tracks costs, and manages sessions is the core product. The UI layer is swappable.

### Key Constraints

- Spawn Claude Code as subprocess via node-pty (stdin/stdout JSON streaming)
- xterm.js terminal emulator with WebGL rendering, true color, ligatures (iTerm2-quality visuals)
- Multiple tabs/panes for sessions + dashboard views
- macOS first, Linux later, Windows eventually
- Keyboard-driven, minimal chrome

### Research

Full analysis in `docs/research/desktop-shells/` — 5 research documents covering VSCode/Electron, LM Studio, Zo Computer, TUI frameworks, and a synthesis with side-by-side comparisons.

---

## F-002: Terminal View

**Priority:** P0
**Status:** Design
**Depends on:** F-001 (Desktop Shell)

### What

A high-quality embedded terminal that IS the Claude Code session. Not a toy terminal — a real terminal emulator on par with iTerm2/Warp quality, where Claude Code runs as the primary interaction surface.

### Design Intent

This is the core of autonomOS. The terminal is not a side panel or an afterthought — it's the main event. When you open autonomOS, you see your Claude Code sessions running in terminals.

```
+-----------------------------------------------------------+
| autonomOS                                        [- o x]  |
| File  Edit  View  Sessions  Help                           |
+-----------------------------------------------------------+
| [Session 1: auth-refactor] [Session 2: api-v2] [+ New]    |
+-----------------------------------------------------------+
|                                                            |
| $ claude --resume abc123                                   |
| > Reading src/auth/middleware.ts...                         |
|                                                            |
| I'll implement the session timeout handler. Let me         |
| read the existing code first.                              |
|                                                            |
| Tool: Read src/auth/middleware.ts                           |
| Tool: Edit src/auth/middleware.ts                           |
|   [Allow]  [Deny]  [Allow All for Session]                 |
|                                                            |
| Done. I've added the handleSessionTimeout() function       |
| with auto-extend behavior on activity.                     |
|                                                            |
| $ _                                                        |
|                                                            |
+-----------------------------------------------------------+
| Context: [====75%====    ]  Cost: $0.42  Model: opus-4-6  |
+-----------------------------------------------------------+
```

### Quality Target: iTerm2 Visual Experience

The terminal must feel premium — not a "web terminal." The benchmark is iTerm2's look and feel brought into a web context. Specific targets:

- **GPU-accelerated rendering** via `@xterm/addon-webgl` (WebGL). Smooth scrolling, no flicker, no tearing.
- **Font rendering:** High-quality monospace with ligature support. JetBrains Mono (default), Fira Code, SF Mono, MesloLGS. Configurable per profile.
- **Color schemes:** Ship with curated themes (Catppuccin, Dracula, Solarized, One Dark, Rosé Pine, etc.). Import iTerm2 `.itermcolors` files.
- **Cursor styles:** Block, underline, bar. Blinking configurable. Cursor color customizable.
- **True color (24-bit):** Full 16.7M color support, not just 256-color.
- **Unicode & emoji:** Proper wide character handling, emoji rendering, CJK support.
- **Selection:** Rectangle/block selection (Alt+drag), double-click word select, triple-click line select.
- **Smooth scrolling:** Not the janky line-by-line jump. Pixel-level smooth scroll like iTerm2.
- **Padding & spacing:** Configurable terminal padding, line height, letter spacing. Breathing room like iTerm2's margin settings.

### Requirements

- **Terminal emulator:** xterm.js with addons: `@xterm/addon-webgl` (GPU rendering), `@xterm/addon-fit` (auto-resize), `@xterm/addon-search`, `@xterm/addon-image` (Sixel/image display), `@xterm/addon-unicode11`, `@xterm/addon-ligatures`.
- **Claude Code integration:** Spawn `claude` CLI as subprocess with `--output-format stream-json --input-format stream-json`. Parse the JSON stream to extract structured data (tool calls, token usage, context window) while still rendering the terminal output.
- **Tabs:** Multiple terminal sessions in tabs, like iTerm2.
- **Split panes:** Horizontal/vertical splits to view multiple sessions simultaneously. Drag to resize. Cmd+D / Cmd+Shift+D to split (iTerm2 convention).
- **Search:** Search within terminal output (Cmd+F). Regex support. Highlight all matches.
- **Copy/paste:** Proper clipboard integration, including block selection.
- **Scrollback:** Large scrollback buffer (configurable, default 10K lines) with efficient rendering via WebGL.
- **Profiles:** Named terminal profiles (font, colors, cursor style, keybindings, shell). Switch per-session. Default profile ships looking great out of the box.
- **Keyboard shortcuts:** Full terminal keybinding pass-through. Ctrl+C, Ctrl+D, Ctrl+Z, etc. must work perfectly. No browser shortcut conflicts stealing keystrokes.
- **Triggers (future):** Regex-matched patterns in output fire callbacks — similar to iTerm2 triggers. Example: highlight error patterns, auto-dismiss permission prompts matching a pattern.

### Terminal Architecture (Web-First)

```
Browser                              Server (Node.js)
+------------------+                 +------------------+
| xterm.js         |                 | node-pty         |
| + addon-webgl    | <-- WebSocket -->| PTY instance     |
| + addon-search   |   (binary)      | (claude process) |
| + addon-fit      |                 |                  |
| + addon-image    |                 | Event parser     |
+------------------+                 | (stream-json)    |
                                     +------------------+
```

Data flows as raw bytes over WebSocket for terminal rendering. In parallel, the server parses the `stream-json` structured output to extract events for the dashboard. Both paths operate on the same PTY stream — the terminal view gets the raw bytes, the chat view and dashboard get parsed events.

### Permission Handling

When Claude Code requests tool approval, autonomOS intercepts and shows:
- Inline in the terminal (as Claude Code normally does), OR
- A richer overlay/dialog with more context (file diff preview, tool description)
- Keyboard shortcuts for approve/deny (e.g., `y`/`n` or `Cmd+Enter`/`Esc`)

### Session Lifecycle

- **New session:** Open new tab, spawns fresh `claude` process
- **Resume session:** Open tab that resumes an existing Claude Code session by ID
- **Attach to external:** Connect to a Claude Code session running in a separate terminal (read-only observation via JSONL scanning)

### Dual Data Path

The terminal view shows raw Claude Code output. But behind the scenes, autonomOS parses the `stream-json` output to extract:
- Token usage per turn
- Tool invocations and results
- Context window utilization
- Cost per model
- Timing stats (Claude thinking vs user response)

This structured data feeds the dashboard, cost tracking, and session history features.

### Deep Dive Topics (for future research)

- xterm.js addon ecosystem and custom addon development
- WebGL rendering pipeline and performance tuning
- iTerm2 `.itermcolors` theme import/export format
- Terminal image protocols (Sixel, Kitty graphics, iTerm2 inline images)
- Keyboard shortcut conflict resolution (browser vs terminal)
- Scrollback buffer memory management for long-running sessions

### Reference Implementations

- **iTerm2:** Visual quality benchmark. Profiles, triggers, GPU rendering, split panes.
- **CC-Insights:** Spawns Claude CLI as subprocess, parses InsightsEvent stream. Best reference for the data extraction layer.
- **YepAnywhere:** Uses Claude Agent SDK `query()` which also spawns CLI. Has the `Supervisor` + `Process` model for managing multiple sessions.
- **VSCode terminal:** xterm.js + node-pty integration. Reference for xterm.js addon usage and PTY Host architecture.
- **code-server:** xterm.js over WebSocket in browser. Validates the exact streaming pattern we'll use.
- **Warp:** Block-based terminal output. Inspiration for treating Claude's turns as visual blocks.
- **Hyper:** Electron + xterm.js terminal emulator. Reference for making xterm.js feel like a native app.

---

## F-003: Chat View

**Priority:** P1
**Status:** Design
**Depends on:** F-002 (Terminal View — same session data, different renderer)

### What

An alternative view of the same Claude Code session, rendered as a structured chat conversation instead of raw terminal output. Think ChatGPT-style message bubbles with rich rendering of tool calls, diffs, and markdown.

### Design Intent

Some people prefer the terminal. Some prefer the chat. Both views show the same session data — they're just different renderers over the same `InsightsEvent` stream.

```
+-----------------------------------------------------------+
| Session: auth-refactor                                     |
| [Terminal View]  [Chat View]  [Split View]                 |
+-----------------------------------------------------------+
|                                                            |
| You                                              2:34 PM  |
| Implement the session timeout handler                      |
|                                                            |
| Claude                                           2:34 PM  |
| I'll implement the session timeout handler. Let me         |
| read the existing code first.                              |
|                                                            |
|   > Read src/auth/middleware.ts                             |
|   > Edit src/auth/middleware.ts                             |
|     +24 lines / -3 lines  [View Diff]                      |
|     [Allow]  [Deny]                                        |
|                                                            |
| Claude                                           2:35 PM  |
| Done. I've added `handleSessionTimeout()` with             |
| auto-extend behavior. Here's what changed:                 |
|                                                            |
|   ```typescript                                            |
|   export function handleSessionTimeout(...) {              |
|     ...                                                    |
|   }                                                        |
|   ```                                                      |
|                                                            |
+-----------------------------------------------------------+
| [Type a message...]                          [Send (Enter)]|
+-----------------------------------------------------------+
```

### Requirements

- **Markdown rendering:** Full GitHub-flavored markdown with syntax highlighting.
- **Tool call cards:** Collapsible cards for tool invocations showing tool name, arguments, and result. Expandable to full detail.
- **Diff view:** Inline diff viewer for Edit tool calls. Side-by-side or unified.
- **Image support:** Render images inline (screenshots, diagrams).
- **Message input:** Text input with multi-line support. Send triggers `session.send()` on the underlying CLI process.
- **Permission prompts:** Rich approval UI with context (what file, what changes, risk level).
- **Auto-scroll:** Follow new messages, but pause auto-scroll when user scrolls up.

### Split View

A third mode that shows terminal on one side and chat on the other, synced to the same session. Useful for seeing both the raw output and the structured view.

### Why Both Views Matter

- **Terminal view** is for power users who want the raw Claude Code experience with zero abstraction.
- **Chat view** is for reviewing sessions, understanding what happened, and for users who prefer structured conversation.
- **Split view** is for debugging — see what Claude Code is actually doing (terminal) alongside the structured interpretation (chat).

### Data Source

Both views consume the same data:
- Terminal view: renders the raw stdout/stderr from the Claude CLI subprocess
- Chat view: parses the `stream-json` InsightsEvent stream into structured messages

This means chat view is a **derived view** — it never has data the terminal doesn't, but it presents it more clearly.

---

## F-004: Session Discovery & Management

**Priority:** P1
**Status:** Design
**Depends on:** F-001 (Desktop Shell)

### What

Find and manage all Claude Code sessions — both ones autonomOS spawned and ones running in external terminals.

### Two Discovery Modes

**1. Spawned sessions (full control)**
- autonomOS starts the Claude CLI subprocess
- Full bidirectional control: send messages, approve tools, interrupt, kill
- Real-time structured data from `stream-json` output
- This is the F-002 Terminal View path

**2. Discovered sessions (observation)**
- Scan `~/.claude/projects/` for JSONL session transcripts (Mission Control pattern)
- Detect active sessions (last message within 5 minutes)
- Read-only: can view conversation, token usage, cost — but can't send messages or approve tools
- Useful for sessions running in other terminals, tmux panes, or remote machines

### Session Index

All sessions (spawned + discovered) stored in a unified index:

```
Session {
  id: string              // Claude session ID
  source: 'spawned' | 'discovered'
  status: 'active' | 'idle' | 'completed'
  project: string         // Project path
  branch: string          // Git branch
  worktree: string?       // Worktree path if applicable
  model: string           // Model used
  tokenUsage: TokenUsage  // Cumulative input/output/cache
  cost: number            // Estimated cost
  startedAt: Date
  lastActivityAt: Date
  messageCount: number
}
```

### Session Actions

| Action | Spawned | Discovered |
|--------|---------|-----------|
| View conversation | Yes | Yes |
| Send message | Yes | No |
| Approve/deny tools | Yes | No |
| Interrupt | Yes | No |
| Resume (after app restart) | Yes (via session ID) | N/A |
| Resume into a managed agent | Yes (attach) | Yes (adopt → managed, see ADR-056) |
| View cost/tokens | Yes (real-time) | Yes (from JSONL) |
| Archive | Yes | Yes |

### Scanner Implementation

Based on Mission Control's `claude-sessions.ts` and YepAnywhere's `FileWatcher`:

1. Watch `~/.claude/projects/` for new/modified `.jsonl` files
2. Parse each file: extract session ID, model, messages, token usage, timestamps
3. Detect "active" sessions (file modified within last 5 minutes)
4. Upsert into session index (SQLite)
5. Emit events for dashboard updates

Scan frequency: file system watcher (instant) + periodic full scan every 60s as fallback.

---

## F-005: Multi-Session Dashboard

**Priority:** P1
**Status:** Design
**Depends on:** F-004 (Session Discovery)

### What

A dashboard view showing all active and recent sessions at a glance. The "home screen" of autonomOS when you're not focused on a single session.

### Layout

```
+-----------------------------------------------------------+
| autonomOS                                                  |
| [Dashboard]  [Session 1]  [Session 2]  [+ New Session]    |
+-----------------------------------------------------------+
|                                                            |
| Active Sessions (3)                                        |
| +-------------------------------------------------------+ |
| | auth-refactor   | opus-4-6 | $0.42 | 75% ctx | 2m ago| |
| | api-v2-endpoint | sonnet   | $0.18 | 45% ctx | 5m ago| |
| | fix-ci-pipeline | haiku    | $0.03 | 12% ctx | 1m ago| |
| +-------------------------------------------------------+ |
|                                                            |
| Recent Sessions (today)                                    |
| +-------------------------------------------------------+ |
| | debug-auth-flow | completed | $1.20 | 45 min          | |
| | refactor-db     | completed | $3.50 | 2.1 hrs         | |
| +-------------------------------------------------------+ |
|                                                            |
| Today's Spend: $5.33  |  Sessions: 5  |  Tokens: 412K   |
+-----------------------------------------------------------+
```

### Per-Session Info

Each session row shows:
- Project/branch name
- Model being used
- Status (active, idle, completed)
- Cost so far
- Context window utilization
- Time since last activity
- Quick actions (open, archive, kill)

### Filters & Search

- Filter by: status, project, model, date range
- Search across session conversations
- Sort by: recent activity, cost, token usage

---

## F-006: Agent Scheduling & Automation

**Priority:** P1
**Status:** v1 Shipped (cron + manual dispatch) — see ADR-026, design doc at `docs/research/cron-scheduler/design.md`
**Depends on:** F-002 (Terminal), F-004 (Session Discovery)

### What

Schedule Claude Code sessions to run on triggers — time-based (cron), event-based (git push, file change, PR comment), or manual dispatch.

### Why High Priority

This is where autonomOS goes beyond "just a Claude Code wrapper" into a real control plane. The ability to say "run this agent every morning to check for dependency updates" or "when a PR gets a comment, spin up Claude to address it" is the killer feature.

### Trigger Types

| Trigger | Example | Priority |
|---------|---------|----------|
| **Manual** | Click "Run" in dashboard | P1 |
| **Cron** | Every day at 9am | P1 |
| **Git event** | On push to main, on PR comment | P2 |
| **File watch** | When a specific file changes | P3 |
| **Webhook** | External service posts to autonomOS | P2 |
| **Agent chain** | When session A completes, start session B | P2 |

### Agent Definition

```
Agent {
  id: string
  name: string
  instruction: string        // The prompt / task description
  project: string            // Project path
  branch: string?            // Branch to work on
  worktree: boolean          // Create a new worktree?
  model: string              // Model to use
  schedule: Schedule?        // Cron expression or trigger config
  costLimit: number?         // Max spend before stopping
  tools: ToolsConfig?        // Tool permissions (allow-all, deny-list, etc.)
  profile: string?           // Reference to an agent profile (F-012)
  notifications: Notification[] // Where to notify on completion
}
```

### Execution Model

1. Trigger fires
2. autonomOS creates a new terminal session (F-002)
3. Spawns Claude Code with the agent's instruction as the initial message
4. Monitors execution: cost, context, completion
5. If cost limit hit, interrupt and notify
6. On completion, log results and notify

### Relation to OpenClaw

OpenClaw already has a cron system. autonomOS's scheduling is complementary:
- OpenClaw cron: runs within OpenClaw's multi-channel agent framework
- autonomOS scheduling: runs Claude Code sessions with full terminal + observability

Long term, autonomOS could orchestrate both.

---

## F-007: Cost Tracking & Analytics

**Priority:** P2
**Status:** Concept
**Depends on:** F-004 (Session Discovery)

### What

Track token usage and costs across all sessions, projects, and models. Time-series analytics with drill-down.

### Data Points

Per turn:
- Input tokens, output tokens, cache read tokens, cache creation tokens
- Model used (opus, sonnet, haiku — costs differ significantly)
- Timestamp

Per session:
- Cumulative tokens and cost
- Duration (wall time, Claude thinking time, user response time)
- Context window peak utilization

Aggregations:
- Per project (daily, weekly, monthly)
- Per model
- Cross-project totals
- Trends over time

### Cost Calculation

Follow Mission Control's approach with cache adjustment:
- Standard input: model rate per 1M tokens
- Cache reads: 10% of input rate
- Cache creation: 125% of input rate
- Output: model rate per 1M tokens

### Visualization

- Time-series chart: daily/weekly spend
- Per-model breakdown (pie/bar)
- Per-project comparison
- Session cost distribution
- Context utilization over session lifetime

### Storage

SQLite table for token usage events. Append-only for raw events, materialized views for aggregations.

### API Surface

Cost data should be queryable via API for external tools:
- `GET /api/costs?range=7d&groupBy=project`
- `GET /api/costs?range=30d&groupBy=model`
- `GET /api/sessions/:id/costs`

---

## F-008: Session History & Search

**Priority:** P1
**Status:** Concept
**Depends on:** F-004 (Session Discovery)

### What

Browse and search past sessions. Every Claude Code session is persisted and searchable.

### Storage

- Raw JSONL transcripts (as Claude Code writes them) are the source of truth
- Parsed/indexed data in SQLite for fast queries
- Full-text search across conversation content

### Search Capabilities

- **Full-text search:** "Where did I implement the auth middleware?"
- **Filter by project, branch, model, date range, cost range**
- **Tool search:** "Show me all sessions that edited middleware.ts"
- **Cost search:** "Sessions that cost more than $5"

### Session Detail View

When you open a past session, you see the Chat View (F-003) in read-only mode:
- Full conversation with tool calls, diffs, markdown
- Token usage timeline
- Cost breakdown
- Git context (branch, commits made during session)

---

## F-009: Git & Worktree Integration

**Priority:** P1
**Status:** Concept
**Depends on:** F-004 (Session Discovery)

### What

Deep integration with git and the worktree workflow. Sessions are aware of their git context, and the dashboard shows git state alongside agent activity.

### Git Context Per Session

Each session knows:
- Repository path
- Current branch
- Worktree path (if using worktrees)
- Uncommitted changes
- Commits made during the session

### Worktree Integration

autonomOS integrates with the existing `wt-plan` / `wt-create` workflow:
- **View:** See all active worktrees and their associated sessions
- **Create:** Create a new worktree + session from the dashboard
- **Link:** Associate sessions with plan files (`~/.claude/plans/*.md`)
- **Status:** Show PR status for worktree branches

### Dashboard View

```
Worktrees
+-------------------------------------------------------+
| terry/auth-refactor  | PR #42 (draft) | 2 sessions    |
| terry/api-v2         | No PR yet      | 1 session     |
| terry/fix-ci         | PR #45 (merged)| archived       |
+-------------------------------------------------------+
```

### PR Tracking

- Detect when a branch has an open PR (via `gh` CLI)
- Show PR status (draft, review requested, approved, merged)
- Link sessions to PRs

---

## F-010: Provider Abstraction Layer

**Priority:** P2
**Status:** Design
**Depends on:** F-002 (Terminal View)

### What

An abstraction layer that lets autonomOS work with different terminal coding agents — not just Claude Code. Initially Claude Code only, but the architecture should support adding providers later.

### Why Think About This Now

Even though we're building for Claude Code first, making the wrong architectural assumptions now would be expensive to fix. The abstraction doesn't need to be implemented for all providers — it just needs to exist so Claude Code isn't hardcoded into the foundation.

### Provider Interface (Conceptual)

```typescript
interface AgentProvider {
  name: string                           // 'claude-code', 'gemini-cli', 'opencode'
  displayName: string

  // Capabilities
  supportsStreamJson: boolean            // Can output structured JSON stream?
  supportsResume: boolean                // Can resume previous sessions?
  supportsPermissionFlow: boolean        // Has tool approval workflow?

  // Lifecycle
  spawn(options: SpawnOptions): AgentProcess

  // Session data extraction
  parseOutput(raw: string): AgentEvent[] // Parse stdout into structured events
  getSessionDir(): string                // Where sessions are stored on disk
  scanSessions(): Session[]              // Discover existing sessions
}
```

### Providers to Consider (Future)

| Provider | CLI Command | Session Format | Permission Flow |
|----------|------------|----------------|-----------------|
| Claude Code | `claude` | JSONL in `~/.claude/projects/` | Yes (tool approval) |
| Gemini CLI | `gemini` | Unknown format in `~/.gemini/` | Unknown |
| OpenCode | `opencode` | HTTP server | Unknown |
| Codex | `codex` | JSON in `~/.codex/sessions/` | Yes |

### Current Scope

For now: implement only `ClaudeCodeProvider`. But structure the code so adding `GeminiCliProvider` later is a matter of implementing the interface, not refactoring the core.

---

## F-011: File Browser

**Priority:** P2
**Status:** Concept
**Depends on:** F-001 (Desktop Shell)

### What

A read-only file tree showing the project's files, with the ability to view file contents. Context for what Claude Code is working on.

### Design Intent

Not trying to be a code editor (that's VSCode's job). This is a **context panel** — see what files exist, what was recently modified, what Claude is reading/editing.

### Features

- File tree with expand/collapse
- File content viewer with syntax highlighting (read-only)
- Highlight files that Claude Code touched in the current session
- Show git status (modified, added, deleted) inline
- Quick "Open in VSCode" action

### Scope

This is explicitly a secondary feature. The terminal and chat views are the primary interface. The file browser is a sidebar for context.

---

## F-012: Agent Profiles & Rules

**Priority:** P3
**Status:** Concept
**Depends on:** F-006 (Agent Scheduling)

### What

Reusable agent configuration templates — like Zo's personas/rules but for Claude Code session behavior.

### What a Profile Includes

```
Profile {
  name: string
  description: string
  systemPrompt: string?        // Prepended to agent instruction
  model: string                // Default model
  toolPermissions: ToolsConfig // Which tools are auto-approved
  costLimit: number?           // Default cost cap
  claudeMdOverrides: string?   // CLAUDE.md content to inject
  tags: string[]
}
```

### Examples

- **"Careful Reviewer"** — Uses opus, low cost limit, no auto-approve on writes
- **"Quick Fix"** — Uses haiku, auto-approve all, high cost limit
- **"Research"** — Uses opus, read-only tools only, no file edits

### Relation to SKILL.md

Zo's SKILL.md pattern is interesting here. Could adopt markdown-based profile definitions:

```markdown
---
name: "Careful Reviewer"
model: opus-4-6
cost_limit: 5.00
auto_approve: [Read, Glob, Grep]
---
## Instructions
Review code changes carefully. Focus on correctness and security.
Do not make changes without explicit approval.
```

---

## F-013: Integrations Dashboard

**Priority:** P3
**Status:** Punt
**Depends on:** F-005 (Dashboard)

### What

View-only dashboard showing what MCP servers and integrations are connected to Claude Code sessions. Not managing them — just visibility.

### Scope (View Only)

- List connected MCP servers per session
- Show which tools each server provides
- Display recent tool calls to each integration
- Health status (connected, disconnected, erroring)

### Future (Control)

Eventually: manage MCP server connections from the dashboard. But this is out of scope for now.

---

## F-014: Mobile & Remote Access

**Priority:** P3
**Status:** Punt
**Depends on:** F-001 (Desktop Shell decisions)

### What

Access autonomOS from a phone or remote machine. Primarily for tool approval notifications when away from the computer.

### Minimal Version

- Push notification when a session needs tool approval
- Simple approve/deny from phone
- View active session status

### Full Version

- Full dashboard in mobile browser
- Relay server for remote access (like YepAnywhere's approach)

### Notes

Punt for now. The desktop app is the priority. Mobile comes after the core experience is solid.

---

## F-015: Web Hosting / Deploy

**Priority:** P3
**Status:** Punt

### What

Let agents deploy what they build — push to Vercel, Netlify, or similar from the dashboard.

### Notes

Interesting but firmly out of scope. Claude Code can already do `vercel deploy` via tools. No need to build this into autonomOS.

---

## F-016: Real-Time Streaming

**Priority:** P0 (infrastructure)
**Status:** Design
**Depends on:** F-001 (Desktop Shell)

### What

The internal event streaming system that powers everything — session events flowing from Claude CLI subprocess to the UI in real-time.

### Architecture

```
Claude CLI subprocess
    | stdout (stream-json)
    v
Event Parser
    | InsightsEvent stream
    v
Event Bus (in-process)
    |
    +---> Terminal View (raw rendering)
    +---> Chat View (structured rendering)
    +---> Dashboard (status updates)
    +---> Cost Tracker (token accounting)
    +---> Session Index (persistence)
    +---> [Future: WebSocket for remote clients]
```

### Event Types (from CC-Insights research)

```typescript
type AgentEvent =
  | { type: 'session_init'; sessionId: string; model: string }
  | { type: 'text'; content: string; role: 'user' | 'assistant' }
  | { type: 'tool_invocation'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: unknown }
  | { type: 'turn_complete'; usage: TokenUsage }
  | { type: 'usage_update'; usage: ModelTokenUsage }
  | { type: 'context_compaction'; before: number; after: number }
  | { type: 'permission_request'; tool: string; args: unknown }
  | { type: 'permission_response'; allowed: boolean }
  | { type: 'subagent_spawn'; agentId: string }
  | { type: 'subagent_complete'; agentId: string }
  | { type: 'session_end'; reason: string }
```

### Why P0

Every other feature depends on this event stream. The terminal view renders it. The chat view structures it. The dashboard aggregates it. Cost tracking accounts it. Without this, nothing works.

---

## Priority Summary

| Priority | Features |
|----------|----------|
| **P0** | F-001 Desktop Shell, F-002 Terminal View, F-016 Real-Time Streaming |
| **P1** | F-003 Chat View, F-004 Session Discovery, F-005 Dashboard, F-006 Scheduling, F-008 History, F-009 Git/Worktree |
| **P2** | F-007 Cost Tracking, F-010 Provider Abstraction, F-011 File Browser |
| **P3** | F-012 Agent Profiles, F-013 Integrations, F-014 Mobile, F-015 Hosting |

### Critical Path

```
F-001 Desktop Shell (DECIDE FIRST)
  |
  +-> F-016 Real-Time Streaming (event infrastructure)
  |     |
  |     +-> F-002 Terminal View (primary UI)
  |     |     |
  |     |     +-> F-003 Chat View (alternative UI)
  |     |     +-> F-004 Session Discovery
  |     |           |
  |     |           +-> F-005 Dashboard
  |     |           +-> F-008 History & Search
  |     |           +-> F-009 Git/Worktree
  |     |           +-> F-007 Cost Tracking
  |     |
  |     +-> F-006 Scheduling (needs terminal + discovery)
  |
  +-> F-010 Provider Abstraction (shapes F-002 + F-004)
```

F-001 (Desktop Shell) blocks everything. That decision must come first.
