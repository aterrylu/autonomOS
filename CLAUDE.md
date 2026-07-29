# autonomOS — Agent Development Guide

## Start Here

1. Read [`README.md`](README.md) — project overview, monorepo structure
2. Read [`docs/FEATURES.md`](docs/FEATURES.md) — feature specifications and design intent
3. Read [`docs/DECISIONS.md`](docs/DECISIONS.md) — all architectural decisions with context and rationale
4. Read [`docs/ROADMAP.md`](docs/ROADMAP.md) — current priorities and what to work on
5. Read [`docs/RESEARCH.md`](docs/RESEARCH.md) — research findings, competitor analysis, learnings

## Project Vision

autonomOS is a **mission control platform for autonomous agents** — a terminal dashboard that spawns Claude Code sessions, tracks their status via hook telemetry, and enables multi-agent coordination through a messaging gateway.

**Current state:** Terminal dashboard + session management + hook relay + multi-agent gateway + MCP tools. The orchestrator/projects/workspaces model described below is the long-term vision, not yet implemented.

**Core concepts (future):**
- **Orchestrator** — PM agent, the main interface. Understands project goals, delegates to workspace agents, tracks progress.
- **Projects** — Logical goals with roadmaps. Can span multiple workspaces. Multiple projects per workspace.
- **Workspaces** — Physical repositories, auto-discovered. Each has active agent sessions.

Two paths that share a common core:
- **Dev Path** — control plane for agent tools (Claude Code, etc.)
- **Robot Path** — persistent agent platform for robotics (aspirational, future)

## Monorepo Structure

```
autonomOS/
├── packages/
│   ├── dashboard/          # Web UI — observability & control
│   │   └── src/layout/         # dockview tabs + split panes (ADR-047, the only layout engine)
│   ├── server/             # Hono + node-pty — API, WebSocket, PTY management
│   │   ├── src/gateway/        # URI-based message router + platform adapters
│   │   ├── src/channel-server/ # Standalone MCP subprocess (server:autonomos)
│   │   └── src/mcp/            # Shared MCP tool definitions (used by both servers)
│   └── core/               # Shared agent abstractions & types
├── docs/
│   ├── DECISIONS.md        # Architectural Decision Records (append-only)
│   ├── FEATURES.md         # Feature specifications (F-001 through F-016)
│   ├── ROADMAP.md          # Current priorities
│   ├── RESEARCH.md         # Research findings & competitor analysis
│   ├── VISION.md           # Project vision
│   └── research/           # Deep-dive research topics
├── CLAUDE.md               # This file — agent development guide
└── README.md               # Project overview
```

## Key Systems

### Hook Relay (`--settings` inline curl)
Every spawned session gets `--settings` with inline hook entries for all 13 Claude Code events. Each hook runs `curl -d @- $AUTONOMOS_SERVER/api/hooks/$SESSION_ID`. The server processes events for agent status tracking (`deriveStatus()` state machine) and notification generation (SendUserMessage, Stop, Notification, PermissionRequest).

**Events:** SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, Stop, Notification, PermissionRequest, SubagentStart, SubagentStop, PreCompact, PostCompact, SessionEnd

### Session Spawning Flags
Sessions are spawned with: `--session-id` (pre-generated UUID), `--brief` (enables SendUserMessage), `--append-system-prompt` (autonomOS context + MCP tool descriptions), `--settings` (hook relay), the agent's permission-mode flags (see below), and optionally `--dangerously-load-development-channels` / `--channels`, and `--mcp-config` (channel server subprocess).

### Permission Modes (`core/src/types/permissions.ts`, ADR-045 + ADR-061)
`PermissionMode` is `ask | auto | plan | bypass` — **our** vocabulary, mapped per provider. `PERMISSION_MODES` in core is the canonical list; the type derives from it, and both Zod schemas are built from it so a new value reaches them automatically.

What that does and does NOT enforce, precisely: adding a value gives a compile error only where a mode is exhaustively keyed (`PERMISSION_MODE_INFO`'s `Record<PermissionMode, …>`). It does **not** error in the provider mappers — they end in `default:` catch-alls, so a fifth mode would silently map to ask-equivalent behavior. And `mcp/tools.ts` keeps a hand-copy (see below) checked by a test, not the compiler. Adding a mode means: core list, `PERMISSION_MODE_INFO`, all three provider mappers, `mcp/tools.ts`.

Two mappings are non-obvious and deliberate: **`ask` emits NO Claude flag** (it IS Claude Code's built-in behavior, and passing `--permission-mode default` perturbs TUI startup enough to break the usage-queue auto-Enter), and **`bypass` emits `--dangerously-skip-permissions` without `--permission-mode`**. Gemini's own flag value for ask-before-acting is the word `default` — an our-name → their-name translation, not an identity.

**One agent, one mode, one source.** `spawnAgent` resolves the effective mode **once, after the agent is resolved** — `params.permissionMode ?? agent.permissionMode` — and the argv plus the reattach write-back both read it. Ordering is the correctness argument: on a reattach the fallback is the EXISTING record, so a resume that says nothing changes nothing; on a fresh spawn it is the just-built record (request → template → `ask`).

Callers (`routes/agents.ts`, `mcp.ts`) must forward `undefined` rather than pre-resolving to `DEFAULT_PERMISSION_MODE` — collapsing it at the call site erases "the caller said nothing", which silently demoted `bypass` agents on every body-less resume. A template's mode ranks BELOW the record on a resume (`templatePermissionMode`), matching `respawnAgent`, which reads `tmpl?.systemPrompt` but pointedly not `tmpl?.permissionMode`. Any mode change on a resume is logged. `restart-all` / `/attach` send no body and respawn from each agent's own record, so they **cannot** re-level an agent.

Persisted layers may still hold the pre-rename spelling `"default"`; every load boundary normalizes via `permissionModeFromStored`. The dashboard's Permission Mode control is a **browser-local localStorage default** for spawns started from that dashboard — it is not a server setting and does not affect agent-initiated spawns. There is no server-side default-permission setting.

`mcp/tools.ts` duplicates the value list on purpose — it must NOT import `@autonomos/core` (it is bundled into `channel-server/dist.mjs` and copied into the binary bundle dir, where that specifier won't resolve). `tools-permission-schema.test.ts` keeps the copy honest.

### Auto-Trust
`attachStartupWatcher()` monitors PTY output for Claude Code's interactive trust prompts and auto-dismisses them. Watches for "Yes, I trust this folder" and "WARNING: Loading development channels" needles after ANSI stripping. Each Enter is needle-verified (retry if the dialog re-renders or the PTY stays silent, capped attempts) because CC's TUI attaches its stdin handler 100-500ms after first paint — blind early writes get swallowed. Configurable via settings panel toggle (default: ON).

### Prompt Delivery Receipt (`agents/promptDelivery.ts`)
A starting prompt travels only as a CLI arg (`claude ... -- <prompt>`), so a startup-dialog race can silently drop it. Sessions spawned WITH a prompt are tracked through the hook stream: spawn → SessionStart → UserPromptSubmit confirms delivery. If SessionStart arrives but UserPromptSubmit doesn't within 20s, the prompt is re-delivered ONCE via PTY bracketed paste + Enter (any turn activity cancels — double-submission is worse than a manual nudge). No SessionStart within 15s → warning only. Failures surface as `SystemWarning` notifications in the dashboard notification panel.

**Hook-relay providers only** (`hooks.eventCount > 0` — Claude Code, Gemini). Codex derives status from its app-server event stream and emits no hook events, so it can never produce a receipt; tracking it fired a false "may have failed to boot" warning on every prompted Codex agent. Consequence: **Codex spawn-with-prompt has no delivery detector** — a `--remote` TUI that fails to attach loses the prompt, and the daemon reports the thread idle, so it looks identical to a finished agent. A daemon-side receipt via `statusLoop` is possible follow-up work.

### Agent Communication (URI-based)
Agents communicate through the gateway using one scheme: **`agent://name`**. There is no broadcast and there are no platform schemes — both were removed in ADR-064. `broadcast://all` returned success unconditionally (including to a fleet of zero, and when every recipient was unreachable) and let any agent inject a turn into every running Codex agent; `slack://` was backed by a `StubAdapter` whose `send()` was a `console.log` returning a fabricated message id, so it reported success for every message by construction. Agents spawned before the removal still carry `broadcast://all` in their baked-in system prompt, so the router answers it with a pointer to `agent://` rather than a bare "unknown scheme".

**A `null` return from `routeMessage` means the destination ACCEPTED the message**, not that a plausible recipient was found. That distinction is load-bearing — the old contract ack'd on resolution, so a sender was told "sent" for a message injected into a dead daemon, a threadless agent, or a socket mid-close. What "accepted" means per provider: **Claude Code** — the write landed on an OPEN, registered, token-verified channel-server socket (NOT a receipt that the agent read it; there is no application-level ack from the far side). **Codex** — the agent's app-server daemon replied to `turn/start`.

**Codex inbound (`gateway/codexControl.ts`)** takes a different path than Claude Code. CC consumes inbound through its channel-server MCP subprocess; Codex has no such channel, so the gateway opens a second JSON-RPC client to the agent's `app-server` daemon and injects a `turn/start`. Delivery is **immediate, including into a busy thread** — Codex owns mid-turn safety via its `followup_task` contract (deliver at a message boundary while sampling, or after the pending tool call completes). An earlier idle gate duplicated that guarantee and deadlocked agents blocked in `collaboration.wait_agent`, which reads as `active`; it was removed in ADR-060 (reversing ADR-057's untested assumption). What remains: a best-effort skip while the last observed status is compacting — untested conservatism, not a measured requirement. It does not guarantee we never inject during compaction: the value is a cache, so it is cleared with its socket and the hold is bounded, after which delivery proceeds and the operator is told the status looked stale. See ADR-060. The queue is a **retry buffer for transport failures only** (socket down, no thread yet, a refused turn — buffer and retry, never drop), and `thread/read` is for dashboard **status** only, never as a delivery gate.

Delivery is **confirmed, not assumed** (ADR-064). `deliverToCodex` returns a promise that settles only on a terminal outcome — the `turn/start` reply (delivered) or teardown (dropped) — and the router awaits it under a bounded window (`DEFAULT_DELIVERY_ACK_MS`, 2s). A message still buffered for a transport retry settles at neither, deliberately: "still trying" is not terminal, so the window expires and the sender is told it has **not** landed and must not re-send (a duplicate makes a Codex agent execute the same instruction twice). It is still retried, and persistent failures still reach the operator via a notification — the sender's ack is now the first signal rather than the only-after-the-fact one. `turn/start` is acked by the daemon on **accept**, not on turn completion, so this does not couple the sender to the recipient's turn length: ADR-060's measurement injected into a thread held busy for 90s and the reply landed inside the 30s RPC deadline. The bound is what keeps that safe if a future Codex changes it. Any caller awaiting `deliverToCodex` **must** bound its own wait.

Two gotchas worth knowing. First, **observed on codex 0.144.6**: an agent spawned *without* a starting prompt showed no thread for minutes while agents spawned *with* one had a thread within seconds — so inbound to a promptless Codex agent queues indefinitely (correctly logged and retried, but it looks healthy on the dashboard). The mechanism was not isolated, so the log line's `(TUI not attached?)` remains a guess; if you diagnose this, verify whether the TUI attached before trusting it. Second, the queue is shifted on the `turn/start` **reply**, not on send, so a teardown racing a reply can log a false `DROPPING` — deliberate, because shifting earlier would reopen the #287 silent-drop class.

### MCP Tool Architecture
Tool definitions live in `packages/server/src/mcp/tools.ts` — shared between:
- **HTTP MCP server** (`mcp.ts`) — served on the internal Unix control socket (`$configDir/control.sock`), NOT the public port (ADR-055). Reachable only by same-user processes on the box; a remote client would need a tunnel or a local forwarder. Still requires the auth token.
- **Channel MCP server** (`channel-server/`) — for autonomOS-spawned CC sessions

Both servers expose: `create_agent`, `list_agents`, `kill_agent`, `set_manager`, `get_org_chart`, `list_templates`, `create_template`, `self_exit`, `create_schedule`, `list_schedules`, `get_schedule`, `update_schedule`, `delete_schedule`, `run_schedule`. The channel server also has `send` (requires gateway WebSocket).

### Cron Scheduler (`scheduler.ts` + `schedules.ts`)
Native timer-based scheduling using Croner v10. Each enabled schedule gets its own `Cron` instance (no polling). Schedules stored as individual JSON files in `~/.autonomos/schedules/<name>.json` (config + state). Run history as append-only JSONL in `~/.autonomos/schedule-runs/<name>.jsonl` (auto-pruned at 2000 lines).

**One execution mode: `agent:<name>`** — sends the prompt to a running agent via the gateway (`routeMessage`). A schedule fires a message; the agent does the work under **its own** `permissionMode`. A schedule cannot grant autonomy, and the target must be alive when it fires (a dead agent = a failed run until it's back).

Note the completion semantics: a run is `success` as soon as the prompt is **delivered**, not when the agent finishes. That's why `onComplete` is deprecated rather than rehomed onto this target — it would announce a completion that hasn't happened. Its delivery code is deleted outright: left gated on the removed target it was still reachable for schedules already on disk, which is the population the deprecation exists to protect.

**The `isolated` mode was REMOVED** (spawned a headless `claude -p`). It was the one execution path in the product outside `PermissionMode`, and it was fail-open in three places at once: the executor's `autonomous !== false`, the MCP schema's `.default(true)`, and the REST route's `: true`. Omitting the field granted `--dangerously-skip-permissions`. Fail-closed wasn't an option — measured, a headless run with no permission flag can't do write work at all, and "no flag" isn't even well-defined there (it inherits the user's `~/.claude/settings.json`). So the path went instead of the default flipping.

**Deprecated to accept-and-ignore no-ops** (kept in the type so pre-removal schedule files and MCP clients still load, per the ADR-058 `capabilities` pattern): `autonomous`, `workingDirectory` (was **required**), `template` (was *already* dead — advertised, read by nothing), `onComplete`, and `RunRecord.output`. An existing `isolated` schedule still loads and is editable, warns once at startup naming itself, and fails any run with a message pointing at `agent:<name>`.

**Key behaviors:** Overlap policies (`skip` default, `allow`), global concurrency limits (`maxConcurrentRuns`, default 3, FIFO queue), startup catch-up for missed runs, one-time schedules (`once:ISO` format). Agents create schedules via MCP tools; the dashboard SchedulesPanel monitors and controls them (no create button in UI). REST API: `GET/POST /api/schedules`, `GET/PUT/DELETE /api/schedules/:name`, `POST /api/schedules/:name/run`, `GET /api/schedules/:name/runs`, `GET /api/scheduler/status`, `PUT /api/scheduler/settings`. See ADR-026 and the scheduler-removal ADR.

### Agent Templates (`~/.autonomos/templates/`)
Reusable blueprints for creating agents. Individual JSON files with: `role`, `description`, `systemPrompt`, `permissionMode`, `model`. Created via `create_template` MCP tool or by dropping a `.json` file in the templates directory. Used via `create_agent(template: "team-lead", ...)`.

Two fields are accepted-and-ignored for backward compatibility: `autonomousMode` (migrated to `permissionMode`, ADR-045 — and a `permissionMode: "default"` written before ADR-061 loads as `ask`) and `capabilities` (removed, ADR-058 — it filtered the MCP tool list without restricting the REST API every agent can already reach, while the injected system prompt advertised the full list either way). Restrict worker agents via `systemPrompt` prose instead.

### Agent Hierarchy (Org Chart)
Hierarchy metadata (`template`, `manager`, `project`) is stored on persisted sessions in `sessions.json`. The org chart is derived at query time from `manager` references. Configured at runtime via `set_manager` MCP tool — agents or the human can organize the hierarchy after spawning. REST API: `GET /api/org`, `PUT /api/org/manager`, `GET/POST /api/templates`.

### Base Context Injection
Every autonomOS-spawned session gets `--append-system-prompt` with a `BASE_CONTEXT` constant covering:
1. **Identity** — agent is named, part of an organization, has manager/peers/reports
2. **Communication** — available MCP tools, async messaging, `from_uri` response pattern
3. **Environment** — dashboard observability, shared codebase, no direct terminal access between agents
4. **Lifecycle** — some agents are long-lived, others exit after a task. Sessions persist across restarts until ended by human, self, or manager

The tool list section interpolates `MCP_INSTRUCTIONS` from `mcp/tools.ts` (single source of truth). Use `--append-system-prompt` (preserves CC defaults + CLAUDE.md). Use `--system-prompt` only for full override.

### Keyboard Shortcuts (dashboard)
All app-level chords live in the registry at `packages/dashboard/src/shortcuts/registry.ts` (ADR-064) — one table consumed by the window capture-phase dispatcher (`useShortcuts`) AND xterm's key handler (`isReservedChord` consult). Never add an ad-hoc keydown listener for a global shortcut; add a registry entry (its unit test enforces chord uniqueness and the browser-reserved / terminal-sacred deny-lists). Pane-order enumeration must use `orderedPaneIds(api.toJSON())` (visual order), never `api.panels` (insertion order). v1 set: mod+1-8 focus pane N, mod+9 last pane, mod+B sidebar, mod+/ help overlay. The key-capture boundary (which chords the app steals from a focused terminal) is owned by Shortcuts@autonomOS.

## Key Conventions

### Decision Records (CRITICAL)
Every architectural decision goes in `docs/DECISIONS.md`. Append-only. Each entry must include:
- **Date** and **who decided** (human vs agent)
- **Context** — why this decision was needed
- **Decision** — what was chosen
- **Rationale** — why this over alternatives
- **Alternatives considered** — what else was evaluated
- **Source** — where the decision happened (Discord channel, CC session, etc.)

Never delete or modify past entries. If a decision is reversed, add a new entry referencing the old one.

### Research & Learnings
All research goes in `docs/RESEARCH.md` or `docs/research/` subdirectories. When investigating competitors, frameworks, or approaches:
- Document what you found with links
- Note what's relevant to autonomOS
- Include your assessment (not just raw info)

### Commit Messages
- `feat:` — new features
- `fix:` — bug fixes
- `perf:` — performance improvements
- `refactor:` — structural changes
- `docs:` — documentation changes
- `research:` — research findings
- `init:` — initial setup

### Terminology
- **UI says "agents"** — sidebar, buttons, labels
- **Code says "sessions"** — types, APIs, server internals
- Both refer to the same entity — a managed CC PTY process

### Session Naming
CC owns session names via JSONL `customTitle`. `titleCache.ts` reads them (256KB tail scan, mtime-cached). The `--name` flag sets the initial name at spawn. `/rename` updates it. The titleCache is more reliable than the SDK's `listSessions()` (which only reads 64KB).

### README Hero Image (keep it current)
The README's hero screenshot (`docs/assets/hero.png`) is generated, not hand-captured. It's produced by `make hero` (→ `packages/dashboard/scripts/capture-hero.ts`), which boots an isolated demo instance (own config dir + fake HOME + ephemeral port — never touches `:3100`), stages a multi-agent scene (org chart across Claude Code / Codex / Gemini, live terminals, both usage bars), and screenshots it via headless Chrome.

**If you change the dashboard UI, re-run `make hero` and commit the updated `docs/assets/hero.png`** — otherwise the front-page hero drifts from the real product. This applies to any visible change: layout/dockview, sidebar, org chart, status bar, terminal chrome, themes, provider icons, usage bars. The script header documents prerequisites (a `claude` binary; optional Codex/Gemini auth for those panes) and the capture-time tweaks it applies. Re-shoots are *similar, not pixel-identical* (the Codex/Claude turns are real).

### Development Philosophy
- **Personal tool first** — ship for Terry, generalize later
- **Both paths share core** — abstractions should work for dev agents AND robots

## What NOT to Do

- Don't make architectural decisions without recording them in DECISIONS.md
- Don't start building without checking ROADMAP.md for priorities
- Don't ignore existing research — check RESEARCH.md before investigating something
- Don't over-engineer for the robot path yet — it's aspirational
- Don't define MCP tool schemas directly in `mcp.ts` or `channel-server/index.ts` — they go in `mcp/tools.ts`
- Don't ship a visible dashboard UI change without re-running `make hero` — the README hero (`docs/assets/hero.png`) must reflect the real product

## Agent Workflow

When working on this repo:
1. Check ROADMAP.md — what's the current priority?
2. Check DECISIONS.md — has this been decided already?
3. Do the work
4. Update ROADMAP.md if priorities shifted
5. Add any new decisions to DECISIONS.md
6. Update RESEARCH.md with any new findings
