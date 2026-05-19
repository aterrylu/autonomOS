# Architectural Decision Records

Append-only log of project decisions. Newest at bottom.
Each entry includes context, rationale, alternatives considered, and source.

---

## ADR-001: Monorepo Structure
**Date:** 2026-03-03
**Decided by:** Terry + Nox
**Source:** Discord #🧭the-bridge (Mission Control category)

**Context:** Need a repo structure that supports two divergent paths (dev tooling + robotics) while sharing core abstractions.
**Decision:** Monorepo with `packages/` directory. `packages/dashboard/` for web UI, `packages/core/` for shared types and abstractions. Additional packages added as needed.
**Rationale:** Single repo keeps everything discoverable. Packages can diverge (robot-specific vs dev-specific) while sharing core types. Same pattern used successfully in the aquarium project.
**Alternatives:** Separate repos per path (too fragmented early on), single flat project (doesn't scale).

---

## ADR-002: Start with Observability, Add Control Later
**Date:** 2026-03-03
**Decided by:** Terry
**Source:** Discord #🧭the-bridge

**Context:** Dashboard could try to do everything at once — observe, configure, and control agents.
**Decision:** Phase 1 is read-only observability. Phase 2 adds control/configuration.
**Rationale:** Observability is safer (no destructive actions), teaches us what data matters, and is useful immediately. Control requires deeper integration and more careful design.
**Alternatives:** Build control first (risky without understanding the data), build both simultaneously (too much scope).

---

## ADR-003: Build on OpenClaw, Diverge If Needed
**Date:** 2026-03-03
**Decided by:** Terry
**Source:** Discord #🧭the-bridge

**Context:** Could build a custom agent runtime from scratch or extend an existing one.
**Decision:** Use OpenClaw as the agent runtime for now. autonomOS sits above it as a control plane. May fork/diverge later if OpenClaw's architecture doesn't fit.
**Rationale:** OpenClaw already handles agent config, cron jobs, memory, multi-channel routing. No need to rebuild that. Focus energy on the control plane layer that's missing.
**Alternatives:** Build custom runtime from day one (premature), fork OpenClaw immediately (unnecessary complexity).

---

## ADR-004: Name — autonomOS
**Date:** 2026-03-03
**Decided by:** Terry
**Source:** Discord #🧭the-bridge

**Context:** Needed a name that reflects agent-first, autonomous operation, and works for both dev and robotics paths.
**Decision:** `autonomOS` — autonomous + OS. Capitalization emphasizes "OS" (operating system for agents).
**Rationale:** Directly communicates the concept. Works as a CLI name, repo name, and brand. GitHub org `Autonomos` is taken (case-insensitive) but `aterrylu/autonomOS` as a repo is available.
**Alternatives:** mission-control (plain), cortex (taken in many contexts), conductor (too narrow — implies only orchestration), fleet (too robot-specific).

---

## ADR-005: Web-First Desktop Shell, Package as Electron Later
**Date:** 2026-03-06
**Decided by:** Terry
**Source:** Claude Code session (architecture research with @Architect)

**Context:** Needed to decide the application shell for autonomOS — the single biggest architectural decision, as it determines tech stack, UX ceiling, distribution, and dev velocity. Researched 5 approaches in depth: Electron (VSCode-style), Electron thin wrapper (LM Studio, Zo), Tauri, pure terminal/TUI, and web-first.

**Decision:** Web-first architecture. Build a server (Node.js) that spawns and manages Claude Code subprocesses, serves a web dashboard (React or Svelte), and exposes REST + WebSocket APIs. Package as Electron desktop app later when the web experience is solid.

**Rationale:**
- Fastest path to v0 — no Electron boilerplate, IPC wiring, or native packaging to start
- YepAnywhere (Hono + React) and amux both validate web-first works for this exact use case
- Terminal embedding via xterm.js works in browser (server-side PTY streamed over WebSocket)
- Mobile/remote access comes for free — approve tools from phone, check on agents remotely
- The server IS the product — CLI, web dashboard, and future Electron wrapper are all clients
- LM Studio pattern: separate the backend daemon from the UI shell. Build the daemon first, add shells later.
- No tmux dependency — spawn Claude Code subprocesses directly from the server process

**Alternatives considered:**
- **Electron-first** — Richer native feel (menus, notifications, dock). But adds Electron boilerplate upfront, no mobile story, and the "real app" packaging can be added later. VSCode's xterm.js + node-pty is gold standard but not exclusive to Electron.
- **Tauri** — Tiny binary (~10 MB vs Electron's ~200 MB), low memory. But Rust PTY libs are less proven than node-pty, WebView inconsistencies across OS, and Rust toolchain adds friction. Good future option for packaging.
- **Pure terminal/TUI** — Terminal-native tools (k9s, lazygit) are loved by developers. SSH-friendly. But cost analytics need real charts, session replay needs rich rendering, and autonomOS aspires beyond session switching. amux uses tmux for process management but the UX is a web dashboard.
- **VSCode fork** — Maximum integration with developer workflow. But enormous maintenance burden (monthly rebasing, marketplace lockout). We're building mission control, not an IDE.

**Key insight:** tmux, Electron, and web are all just process management + UI. The server that spawns Claude Code, parses events, tracks costs, and manages sessions is the core product. The UI layer is swappable. Start with the lightest UI (web) and add heavier ones (Electron) only when needed.

**Research:** Full analysis in `docs/research/desktop-shells/` — 5 research documents covering VSCode/Electron architecture, LM Studio, Zo Computer, TUI frameworks, and a synthesis with side-by-side comparisons.

---

## ADR-006: Agent-First Architecture, Claude Code as First Provider
**Date:** 2026-03-06
**Decided by:** Terry
**Source:** Claude Code session (architecture research with @Architect)

**Context:** autonomOS could tightly couple to Claude Code, or build a provider abstraction that supports multiple agent backends. Also considering whether to use an existing agent framework or develop our own.

**Decision:** Build agent-first with our own framework. Claude Code is the first provider, but the architecture should not hardcode Claude Code assumptions. The provider abstraction (F-010) exists from the start as an interface, even though only one implementation exists initially. We may develop our own agent framework within autonomOS over time.

**Rationale:**
- Claude Code is the immediate focus and what we use daily
- But the agent landscape is moving fast (Gemini CLI, OpenCode, Codex) — locking in would be short-sighted
- A clean provider interface costs almost nothing upfront (just an interface + one implementation)
- OpenClaw already abstracts multiple agent backends — same pattern applies here
- Developing our own agent framework keeps options open for the robot path and custom orchestration
- "Agent-first" means the platform is designed around agent concepts (sessions, tools, permissions, cost), not around any specific CLI tool

**Alternatives:**
- **Claude Code only, no abstraction** — Simpler to start but creates migration pain when adding providers. The CC-Insights approach (GPLv3, Dart, Claude-only) shows the risk of tight coupling.
- **Use an existing agent framework (LangGraph, Claude Agent SDK)** — These operate at a different layer (agent reasoning) vs autonomOS (agent orchestration/observability). Not mutually exclusive — our framework could use these internally.

---

## ADR-009: Bun + Hono Server Stack
**Date:** 2026-03-06
**Decided by:** Terry
**Source:** Claude Code session (architecture research with @Architect)

**Context:** Needed to choose the runtime and server framework for autonomOS. Key requirements: WebSocket support (terminal streaming), SSE (dashboard events), HTTP API, static file serving, and future multi-tenant scalability. Also considering the multi-provider AI proxy future (ADR-008).

**Decision:** Bun as the runtime, Hono as the server framework.

**Rationale — Bun:**
- Anthropic acquired Bun in December 2025. Claude Code (the tool we're wrapping) runs on Bun. Same ecosystem.
- Bun's HTTP stack uses uWebSockets (C++) under the hood — excellent WebSocket performance for terminal streaming.
- 7M+ monthly downloads, 82K+ GitHub stars. Used in production by Anthropic, X, Midjourney, Lovable, Cursor.
- Bun is not going away — it's backed by Anthropic's $1B+ Claude Code revenue.
- Faster startup, lower memory than Node.js.

**Rationale — Hono:**
- Multi-runtime: runs on Bun, Node.js, Deno, Cloudflare Workers. If Bun has a compatibility issue (e.g., with node-pty), we can fall back to Node.js with zero code changes.
- Cloudflare uses Hono internally across production infrastructure (D1, KV, Queues, Workers Logs).
- 25K+ GitHub stars, 1.5M+ weekly npm downloads — 5-6x Elysia's adoption.
- Native WebSocket and SSE support, no plugins needed.
- 14KB framework size — gets out of the way.
- Portkey AI uses Hono as an AI API gateway — validates the pattern for our future multi-provider proxy.
- YepAnywhere (our closest reference implementation) uses Hono for the same use case.

**Alternatives considered:**
- **Elysia (Bun-native)** — Fastest benchmarks (~530K req/s vs Hono's ~300K on Bun). But adoption is thin (~277K weekly downloads vs Hono's 1.5M+), largely a single developer's project, and Bun-only (no fallback). Performance headroom is irrelevant for our workload.
- **Fastify (Node.js)** — Most mature Node.js framework. But Node-only, no Bun optimization, and partial Bun compatibility issues with some plugins.
- **Express** — Legacy. 15K req/s, callback-based, no native TypeScript. No reason to choose it for a new project.
- **Next.js** — Frontend framework with API routes. Poor WebSocket support, heavy, SSR-focused. Wrong tool for a server process.

**Key risk:** node-pty compatibility with Bun is less tested than on Node.js. Mitigation: Hono's multi-runtime support means we can run on Node.js if PTY spawning has issues on Bun, with zero code changes.

---

## ADR-007: TypeScript Everywhere
**Date:** 2026-03-06
**Decided by:** Terry
**Source:** Claude Code session (architecture research with @Architect)

**Context:** Needed to choose the implementation language for server, dashboard, and core types.

**Decision:** TypeScript for all packages — server, dashboard, and core types.

**Rationale:**
- node-pty (terminal spawning) is a Node.js library — server must be Node.js
- xterm.js (terminal rendering) is TypeScript — dashboard is TypeScript regardless
- Shared types between server and dashboard with zero serialization/translation layer
- Claude Code, OpenClaw, YepAnywhere, Mission Control are all TypeScript — ecosystem alignment
- If we build our own agent framework, TypeScript is natural for a web-first platform
- Performance is sufficient — the server mostly shuttles bytes and parses JSON, not compute-heavy

**Alternatives:**
- **Go** — Better raw performance, great for CLI tools (k9s, lazygit). But loses shared types with dashboard, requires separate frontend build, and node-pty equivalent (no direct match) adds friction.
- **Rust** — Best performance, great for terminal tools (Warp, Ghostty, Zellij). But highest dev cost, Rust learning curve, and the server workload doesn't justify it.
- **Python** — DimensionalOS and amux use it. But worst performance for a server, no shared types with dashboard, and the team is TypeScript-native.

---

## ADR-008: Local-First with Multi-Tenant Future
**Date:** 2026-03-06
**Decided by:** Terry
**Source:** Claude Code session (architecture research with @Architect)

**Context:** autonomOS could be built as local-only (personal tool) or designed from the start to support multi-tenant deployment (SaaS). Zo Computer is a reference for the SaaS model.

**Decision:** Build local-first single-tenant for v0. But architect with multi-tenant extensibility in mind — don't make decisions that would prevent scaling to a hosted SaaS product later.

**Concrete implications:**
- Use SQLite for v0 (zero ops, single user) but abstract the data layer so PostgreSQL can be swapped in
- Auth is optional for localhost but the auth middleware hook exists from the start
- API design should be tenant-aware in naming even if there's only one tenant (avoid hardcoding "my sessions" — use scoped queries)
- AI provider routing: start by letting Claude Code handle its own API calls, but plan for a multi-provider proxy layer that consolidates cost tracking across providers and models
- Configuration should support both file-based (local) and DB-based (multi-tenant) storage

**Rationale:**
- Local-first ships faster and solves the immediate personal need
- But the product has commercial potential — Zo charges $18-200/mo for a similar (though different) product
- The cost of "keeping the door open" for multi-tenant is low if done from the start (abstractions, not implementations)
- The multi-provider AI proxy is valuable even in single-tenant mode for consolidated cost tracking

**Alternatives:**
- **Local-only forever** — Simpler but caps the project's potential. Fine for a personal tool, limits commercial viability.
- **Multi-tenant from day one** — Over-engineering. Adds auth, tenant isolation, billing, and deployment complexity before we've validated the core product.

---

## ADR-010: React + Zustand + Tailwind for Dashboard UI
**Date:** 2026-03-07
**Decided by:** Terry
**Source:** Claude Code session (tech stack research)

**Context:** The v0 dashboard was built with vanilla TypeScript + direct DOM manipulation. This works for a single terminal view but won't scale as the dashboard grows (multi-session, panels, settings, analytics). Needed to decide on a UI framework.

**Decision:** React (via Vite) + Zustand for state management + Tailwind CSS for styling. Hono remains the backend server (ADR-009). No Next.js — it would duplicate Hono's role.

**Rationale:**
- Every comparable product in our research uses React: Zo Computer (Next.js/React + Tailwind), Mission Control (React + Zustand), LM Studio (React + Radix + Tailwind), YepAnywhere (React + Hono)
- VSCode is the only outlier (vanilla TS), but they have a 50+ person team and are building an IDE, not a dashboard
- React + Vite is the lightest integration — Vite already supports React out of the box, no new build tooling
- Zustand is proven for this exact use case (Mission Control uses it for agent dashboard state)
- Tailwind is the modern default for utility-first styling, used by Zo and LM Studio
- AN SDK (21st.dev) is React-based — future agent-controllable UI requires React

**Alternatives:**
- **Vanilla TS / Web Components (VSCode approach)** — Maximum performance control, no framework overhead. But requires building your own component model, state management, and routing. Only viable with a large team.
- **Next.js** — React + SSR + API routes + routing. But duplicates Hono (ADR-009), adds SSR we don't need (no SEO), would mean running two servers or abandoning our existing backend.
- **Svelte** — Lighter than React, less boilerplate. But smaller ecosystem, fewer component libraries, and AN SDK is React-only.
- **Vue** — Mature framework. But less ecosystem alignment with our research targets and agent SDK landscape.

---

## ADR-011: Zustand as Single Source of Truth for All Client State
**Date:** 2026-03-07
**Decided by:** Terry
**Source:** Claude Code session (session management feature)

**Context:** The dashboard was using a mix of Zustand store and direct `localStorage` calls for persisting state (theme, sessionId). As the dashboard grows (session management, panels, preferences), we need a consistent pattern for client-side state.

**Decision:** All client-side state lives in a single Zustand store. Never use `localStorage` directly — use Zustand's `persist` middleware to handle serialization. The `partialize` option explicitly declares which fields are persisted vs transient.

**Rules:**
- One store (`store.ts`), no secondary stores
- `persist` middleware with `partialize` — only persist what's needed (theme, sessionId, UI preferences)
- Transient state (sessions list, connection status) is NOT persisted — fetched fresh on load
- All components read state via `useStore` selectors

**Rationale:**
- Mission Control (our reference product) explicitly uses a single Zustand store pattern
- Eliminates scattered `localStorage.getItem/setItem` calls — one place to manage persistence
- `partialize` makes persistence explicit — easy to audit what survives a page refresh
- Zustand's `persist` handles edge cases (storage full, invalid JSON) that manual calls don't
- Single store keeps state dependencies visible and debuggable

**Alternatives:**
- **Multiple stores** — Zustand supports it, but adds coordination complexity. Not needed at our scale.
- **Manual localStorage** — What we had. Works but doesn't scale — each new persistent field needs manual get/set/sync.
- **React Context** — No persistence built in, more boilerplate, re-render issues at scale.

---

## ADR-012: Orchestrator-First Vision — autonomOS as an Agent, Not Just a Dashboard
**Date:** 2026-03-08
**Decided by:** Terry
**Source:** Claude Code session (@Architect)

**Context:** After building the initial dashboard (terminal view, project browser, session management), a clearer vision emerged: autonomOS shouldn't just be a passive dashboard that *observes* agents — it should *be* an agent. The main interface is an orchestrator (PM agent) that manages projects, delegates to workspace agents, and provides a unified control plane. This aligns with Zencoder's "project-first" approach but goes further by making the orchestrator itself an agent.

**Decision:** Redefine autonomOS around three core concepts:

1. **Orchestrator** — A PM agent that is the primary interface. The main page IS a conversation with the orchestrator. It understands projects, delegates tasks, tracks progress, and coordinates across workspaces.

2. **Projects** — Logical goals with roadmaps. A project can span multiple workspaces (e.g., "Add auth" touches `api`, `dashboard`, `docs` repos). Multiple projects can exist within the same workspace. Projects have status, milestones, and context that persists across sessions.

3. **Workspaces** — Physical repositories, auto-discovered from the local machine. Each workspace can have active agent sessions. Workspaces are the "where" — projects are the "what."

**Architecture shift:**
- The landing page becomes the orchestrator chat, not a session list
- Project browser shows logical projects (with their roadmaps/status), not just directories with sessions
- Workspace browser shows repos with their active sessions (the current project browser, renamed)
- Terminal and conversation views are how you interact with workspace-level agents
- The orchestrator delegates to workspace agents, which are the Claude Code sessions we already manage

**Rationale:**
- The current "passive dashboard" model requires the user to manually manage sessions, context, and project state — that's exactly what an agent should do
- Zencoder research shows "project-first" resonates — but their approach is IDE-centric. autonomOS can be platform-agnostic by making the orchestrator a standalone agent
- The infrastructure already exists: we spawn Claude Code sessions, manage PTYs, and stream output. Adding an orchestrator layer on top leverages all of this
- Projects spanning workspaces is a real workflow — features often touch multiple repos
- This differentiates autonomOS from terminal wrappers (YepAnywhere) and IDE plugins (Zencoder)

**Alternatives:**
- **Stay as passive dashboard** — Simpler, but doesn't solve the coordination problem. Users still manually manage context and project state across sessions.
- **IDE integration (Zencoder model)** — Tighter developer workflow, but locks into VSCode. autonomOS should be editor-agnostic.
- **Pure orchestration API (no UI)** — Could work as a headless agent manager, but loses the observability value. The UI is what makes agents trustworthy and debuggable.

---

## ADR-013: Modular Plugin System with VSCode-Style Status Bar
**Date:** 2026-03-10
**Decided by:** Terry
**Source:** Claude Code session

**Context:** The dashboard needs extensible features (usage tracking, status indicators, future tools) without bloating core components. VSCode's plugin model and status bar are a proven pattern for this.

**Decision:** A static plugin registry with a VSCode-like bottom status bar. Each plugin is a self-contained module that registers status bar items and optional panels.

**Plugin interface:**
- `DashboardPlugin` — declares `id`, `name`, `statusBarItems[]`, and optional `panels[]`
- `StatusBarItem` — `id`, `align` (left/right), `priority`, `component` (a React `ComponentType` that manages its own data)
- Plugins are imported at build time and added to a static array in `plugins/registry.ts`
- Server-side plugin routes are mounted explicitly in `index.ts` (no auto-discovery)

**First plugin: Claude Usage** — aggregates token usage from JSONL session files across all `~/.claude/projects/` with mtime-based caching. Displays compact summary in the status bar, click-to-expand detail panel. Forward-compatible with `rate_limit_event` entries when the SDK starts emitting them.

**File structure:**
- `packages/dashboard/src/plugins/` — plugin types, registry, and per-plugin directories
- `packages/server/src/plugins/` — server-side scanner and route per plugin
- `packages/dashboard/src/components/StatusBar.tsx` — renders items from all registered plugins

**Rationale:**
- Static registry is dead simple — no dynamic loading, no DI, no event bus. One import + one array entry to add a plugin.
- Self-contained plugins (own data fetching, own components) avoid cross-plugin coupling
- Status bar is a proven UX pattern for always-visible metadata (VSCode, terminals, IDEs)
- JSONL scanning reuses existing mtime-caching patterns from `titleCache.ts`

**Alternatives:**
- **Dynamic plugin loading** — Runtime discovery/loading of plugins. Over-engineered for a personal tool with <10 plugins.
- **Dashboard-only (no server routes)** — Some plugins need server-side processing (JSONL scanning). Keeping server routes explicit per-plugin is simpler than client-side file access.
- **Anthropic API for usage** — Admin API requires org-level keys; OAuth endpoint is undocumented and currently returning 429s. JSONL scanning is reliable and works offline.

---

## ADR-014: Multi-CLI Provider Adapter Pattern
**Date:** 2026-03-11
**Decided by:** Terry + Claude
**Source:** Claude Code session (multi-provider planning)

**Context:** autonomOS is tightly coupled to Claude Code across four layers: binary resolution, CLI arg construction, session discovery, and usage scanning. We want to support Gemini CLI, Codex CLI, and future CLIs without duplicating integration code. Both Gemini CLI (v0.30.0) and Codex CLI (v0.114.0) are already installed.

**Decision:** Introduce a `CLIProvider` adapter interface. Each CLI tool implements this interface in a single file. A provider registry holds all known adapters. The session manager (`sessions.ts`) uses the adapter to get binary path, args, and env — but owns all PTY lifecycle.

**CLIProvider interface:**
```
metadata: { id, displayName, icon, available }
detectBinary(): string | null
buildArgs(options): string[]          // full argv including subcommands
buildEnv(baseEnv): Record<string, string>
discoverSessions(): Promise<DiscoveredSession[]>
resolveTitle?(nativeSessionId, cwd): Promise<string | null>
```

**Key decisions within this ADR:**
1. **Provider knows args, session manager owns PTY** — adapters return binary + args + env. No duplication of PTY logic.
2. **`buildArgs()` returns full argv** — handles Codex's subcommand pattern (`codex resume <id>`) naturally.
3. **Discovery is async and per-provider** — Claude uses SDK, Gemini reads JSON files, Codex queries SQLite. Projects route aggregates with `Promise.all`.
4. **`claudeSessionId` → `nativeSessionId`** — generic field for any provider's session ID.
5. **Default provider = `"claude-code"`** — backward compatible.
6. **Usage plugins stay provider-specific** — no forced generalization across different formats.

**CLI comparison:**

| Feature | Claude Code | Gemini CLI | Codex CLI |
|---------|-------------|------------|-----------|
| Binary | `claude` | `gemini` | `codex` |
| Autonomous | `--dangerously-skip-permissions` | `--yolo` | `--full-auto` |
| Resume | `--resume <id>` | `--resume <index>` | `resume <id>` (subcommand) |
| Sessions | `~/.claude/projects/` JSONL | `~/.gemini/tmp/` JSON | `~/.codex/` SQLite+JSONL |

**Migration path:**
- Phase 1: Extract Claude adapter, provider registry, rename fields (zero behavioral change)
- Phase 2: Add Gemini CLI adapter + dashboard provider badges
- Phase 3: Add Codex CLI adapter (SQLite session discovery)
- Phase 4: Provider-specific usage plugins (optional)

**Rationale:**
- Interface (not base class) because each CLI is different enough that inheritance would be forced
- Adapter pattern keeps provider logic isolated — adding a new CLI is one file + one line in registry
- Centralizing PTY management prevents duplication and keeps WebSocket streaming provider-agnostic
- Phased approach means we ship value incrementally without blocking on all providers

**Alternatives:**
- **Separate server per provider** — Too much infrastructure for a personal tool
- **Generic CLI wrapper (just spawn any binary)** — Loses provider-specific features (session discovery, resume, autonomous mode mapping)
- **Plugin-based providers** — The plugin system (ADR-013) is for dashboard features. Provider adapters are server-side infrastructure — different concern, different pattern

---

## ADR-015: VSCode-Style Session Lifecycle — Keep Terminals Alive
**Date:** 2026-03-10
**Decided by:** Terry
**Source:** Claude Code session (terminal UX improvements, PRs #23, #24)

**Context:** Switching between sessions destroyed the old terminal and created a new one. This caused visible flicker, lost scroll position, and required a full WebSocket reconnect on every switch. Users expect instant tab switching like VSCode or browser tabs.

**Decision:** Keep all session terminals mounted in the DOM simultaneously. Hide inactive sessions with `display: none`. Only the visible terminal holds a WebGL GPU context — hidden terminals dispose their WebGL addon and re-acquire it when shown.

**Implementation:**
- `SessionViewManager` renders a `SessionPane` for every active session, not just the current one
- `SessionPane` receives a `visible` prop that controls `display: none` vs `display: flex`
- WebGL addon is loaded/disposed via `ResizeObserver` — when a container has zero dimensions (hidden), WebGL is disposed; when visible, it's re-acquired
- WebSocket connections stay open for all sessions — no reconnect needed on switch

**Rationale:**
- Instant switching — no terminal creation, no WebSocket handshake, no flicker
- VSCode uses the same pattern for editor tabs (mount once, toggle visibility)
- WebGL context management prevents GPU memory leaks from hidden terminals
- Scroll position, command history, and terminal state are preserved per session

**Alternatives:**
- **Destroy/recreate on switch** — What we had. Simple but causes visible flicker (200-500ms) and loses state.
- **Offscreen canvas / terminal serialization** — Save terminal state and restore. Complex and xterm.js doesn't expose a clean serialize/restore API for full fidelity.

---

## ADR-016: Pinned Sessions with Stable Ordering
**Date:** 2026-03-13
**Decided by:** Terry
**Source:** Claude Code session (session persistence feature, PR #26)

**Context:** Sessions are ephemeral — they die on server restart. Users want certain sessions to survive restarts (e.g., long-running agents). Also, drag-to-reorder used ephemeral session IDs, so ordering reset on every restart.

**Decision:** Two features: (1) Pin sessions to persist across restarts. (2) Store session order using `claudeSessionId` (Claude Code's stable session UUID) instead of the ephemeral server-assigned ID.

**Pinning implementation:**
- `POST /api/sessions/:id/pin` / `DELETE /api/sessions/:id/pin` — toggle pin state
- Pinned sessions saved to `~/.autonomos/pinned-sessions.json` (validated on read)
- Server auto-resumes pinned sessions on startup, logging success/failure counts
- UI: pin icon (VSCode Codicon) appears on hover, stays visible when pinned

**Ordering implementation:**
- `sessionOrder` in Zustand store stores an array of `claudeSessionId || id` strings
- `sortSessions()` resolves each session against the order map, using `claudeSessionId` first (stable) with fallback to ephemeral `id`
- Fixed falsy-zero bug: `indexOf` returning `0` was treated as falsy by `&&` — switched to explicit `undefined` check

**Rationale:**
- `claudeSessionId` is assigned by Claude Code SDK and persists across server restarts — natural stable key
- File-based persistence (`pinned-sessions.json`) is simpler than a database for a personal tool
- Pin UX is familiar from browser tabs, IDE tabs, and chat apps

**Alternatives:**
- **Auto-persist all sessions** — Too aggressive. Most sessions are throwaway. Explicit pinning gives user control.
- **Database-backed persistence** — Over-engineered for v0. File-based with JSON schema validation is sufficient.
- **Session names as ordering key** — Names aren't unique and can change. `claudeSessionId` is a UUID.

---

## ADR-017: Simplified Deployment — Dev/Prod Split, No Tailscale Sidecar
**Date:** 2026-03-13
**Decided by:** Terry
**Source:** Claude Code session (Makefile simplification, PR #28)

**Context:** The Makefile had a single `make up MODE=dev|prod` command with embedded Docker Compose for a Tailscale sidecar container. This was complex, required Docker, and all development devices were already on the Tailscale network anyway. The prod instance on forge was also the development target, causing port conflicts.

**Decision:** Split into `make dev` (port 3101 + Vite HMR on 5173) and `make prod` (port 3100, built dashboard). Remove Docker Compose and Tailscale sidecar entirely. `DEPLOY_HOST` is configurable via `.env` (gitignored, per-machine).

**Key changes:**
- `make dev` — server on `:3101`, Vite dev server on `:5173` with proxy to `:3101`
- `make prod` — builds dashboard, serves everything on `:3100`
- `make deploy` — rsync to remote host, `DEPLOY_HOST` read from `.env`
- Deleted `deploy/` directory (docker-compose.yml, serve.json)
- No more Docker dependency for development or deployment

**Rationale:**
- All devices are on Tailscale — the sidecar was unnecessary complexity
- Separate ports (3100 prod, 3101 dev) allow running both simultaneously on the same machine
- `.env` for per-machine config is a well-understood pattern (already gitignored)
- Direct process management (`make prod`) is simpler than Docker for a single-binary server

**Alternatives:**
- **Keep Docker Compose** — Useful if deploying to machines without Tailscale, but adds Docker dependency for no current benefit.
- **Single port with mode flag** — What we had. But can't run dev and prod simultaneously.
- **Systemd service** — More robust for production, but premature for a personal tool. Can be added later.

---

## ADR-018: Dashboard-Hosted File Preview via URL Route
**Date:** 2026-03-14
**Decided by:** Terry
**Source:** Claude Code session (markdown preview feature)

**Context:** Claude Code terminal output is full of markdown file paths. No way to preview them without switching to VSCode or another tool. Considered multiple approaches: split pane in terminal, slide-over panel, and dashboard-hosted URL.

**Decision:** Dashboard-hosted URL route (`/preview?file=/path/to/file.md`). The terminal detects `.md` paths via xterm.js `ILinkProvider` and opens them in a new browser tab. The dashboard serves a `/preview` route that fetches file content from the server and renders it with `react-markdown` + `remark-gfm` + `mermaid`.

**Architecture (3 layers):**
1. **Server endpoint** — `GET /api/files/read?path=...` returns file content as JSON (1MB limit)
2. **Dashboard route** — `/preview` page, conditionally rendered in `main.tsx` based on URL path (no router library needed)
3. **Terminal link provider** — `MarkdownLinkProvider` class registered on each terminal instance, regex-matches `.md` paths, ctrl+click opens preview URL

**Rationale:**
- Simplest approach — no split pane state, no resize handling, no WebGL context juggling
- Reusable building blocks: `/api/files/read` is a general file API, `/preview` route can extend to other file types
- Shareable URLs — can bookmark or share a preview link
- The `/preview` route + file API naturally evolves into a general file viewer (syntax-highlighted code, images) without redesign
- Mermaid support via fenced code blocks (`\`\`\`mermaid`) with DOMPurify sanitization

**Alternatives:**
- **Split pane in SessionPane** — IDE-like side-by-side terminal + preview. More complex (resize logic, per-session state, WebGL context management). Can be added later using the same renderer component.
- **Slide-over overlay** — Middle ground between URL and split pane. But still covers the terminal and needs overlay state.
- **External tool (VSCode preview)** — Already works but requires context-switching out of autonomOS.

---

## ADR-019: Agent Platform — Folder-Based Agent Definitions
**Date:** 2026-03-17
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** Need a model for defining, storing, and running autonomous agents in autonomOS. Options ranged from monolithic config files (OpenClaw's `openclaw.json`) to database-backed entries (Claudia's SQLite) to folder-per-agent structures.

**Decision:** Flat folder-per-agent under `~/.autonomos/agents/`. Each agent is a self-contained directory:
```
~/.autonomos/
├── CLAUDE.md                        # base context for ALL agents
├── OWNER.md                         # owner profile, injected for all agents
└── agents/
    └── home-presence/
        ├── agent.json               # schedule, model, display metadata
        ├── state/                   # shared across all sessions of this agent
        └── .claude/
            ├── CLAUDE.md            # agent-specific behavior
            ├── settings.json        # allowed tools, permissions, MCP servers
            └── skills/
```

**agent.json schema (deliberately minimal):**
```json
{
  "name": "Home Presence",
  "description": "Monitors cameras and presence",
  "model": "sonnet",
  "schedule": {
    "cron": "*/5 * * * *",
    "mode": "oneshot"
  }
}
```

`agent.json` only contains what the autonomOS runner needs: **name, description, model, schedule.** Everything else (allowed tools, permissions, hooks, MCP servers) lives in `.claude/settings.json` where Claude Code already expects it. No duplication.

**Rationale:**
- Adding an agent = dropping a folder. No central config file to edit.
- Each agent is independently version-controllable and shareable.
- JSON over YAML — consistent with `.claude/settings.json`, no YAML parser dependency.
- `agent.json` is deliberately thin: only runner concerns. Agent capabilities/permissions stay in `.claude/` where Claude Code already handles them.
- Mirrors how Claude Code itself works (`.claude/` folder = local config). Familiar mental model.
- Flat structure avoids hierarchy complexity. All agents are peers.
- Validated by Jinn (config + adjacent CLAUDE.md) and OpenClaw (flat agent list).

**Alternatives:**
- **Monolithic config** (OpenClaw model) — editing a central file to add agents. Not composable.
- **SQLite rows** (Claudia model) — not version-controllable, GUI-required to edit.
- **YAML instead of JSON** — readable but adds a parsing dependency. JSON is native to Node.js and consistent with the rest of the `.claude/` ecosystem.
- **Hierarchical template/instance model** — `templates/` + `agents/` with singleton/multi/job split. Too confusing for v1. Collapsed to flat.
- **Put allowedTools in agent.json** — duplication. `.claude/settings.json` already handles this and is what the SDK reads.

---

## ADR-020: Agent Context Assembly — Explicit systemPrompt Over SDK Parent-Dir Walk
**Date:** 2026-03-17
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** The Claude Agent SDK automatically walks parent directories for CLAUDE.md files when `settingSources` includes `"project"`. This could be used to inherit `~/.autonomos/CLAUDE.md` by placing agents under `~/.autonomos/`. However, this behavior is a side effect of `settingSources`, not a documented primary feature, and breaks if agent folders move.

**Decision:** The autonomOS agent runner explicitly assembles the system prompt from files and injects via the `systemPrompt` parameter. `settingSources: ["project"]` is used only for skills and `settings.json` — not for CLAUDE.md inheritance.

```typescript
const baseContext = readFile("~/.autonomos/CLAUDE.md")
const agentContext = readFile(`agents/${name}/.claude/CLAUDE.md`)

query({
  prompt: triggerMessage,
  options: {
    systemPrompt: `${baseContext}\n\n---\n\n${agentContext}`,
    cwd: agentFolder,
    settingSources: ["project"],   // loads skills + settings.json only
  }
})
```

**Context layers an agent sees:**
1. `systemPrompt` — explicitly assembled base context + agent-specific context
2. `settingSources: ["project"]` — skills from `.claude/skills/`, permissions from `.claude/settings.json`
3. `prompt` — the trigger message (cron tick message or user message)

**Rationale:**
- Explicit assembly is debuggable — log the full system prompt before each run.
- Location-independent — agent folders can live anywhere, not just under `~/.autonomos/`.
- Not subject to SDK behavior changes. Parent-dir walking is undocumented side effect behavior.
- Composition order is controlled — base context always before agent context.

**Alternatives:**
- **Rely on SDK parent-dir walk** — simpler but fragile. Breaks on folder moves, depends on undocumented behavior, hard to debug.
- **Symlink CLAUDE.md** — fragile, platform-specific, still implicit.

---

## ADR-021: Agent Session Model — oneshot vs persistent
**Date:** 2026-03-17
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** Scheduled agents need a session model. Two options: spawn a fresh session per cron tick (stateless), or maintain one long-lived session and message into it (stateful).

**Decision:** Two modes, `oneshot` (default) and `persistent`. Controlled by `schedule.mode` in `agent.json`.

**oneshot (default):**
- Fresh isolated session per cron tick
- Agent reads `state/` at start, does work, writes `state/`, session dies
- No context window growth over time
- Cheap, predictable, maps to OpenClaw's `sessionTarget: "isolated"`

**persistent:**
- One long-lived session, cron tick sends a message into it
- Agent retains full conversation history across ticks
- Context accumulates — requires a compaction/archival strategy
- Use only when multi-turn reasoning across ticks genuinely matters
- Maps to OpenClaw's `sessionTarget: "main"`

**Default to `oneshot`.** Use `persistent` only with a specific stated reason.

**Rationale:**
- `oneshot` avoids context window growth, the primary failure mode for long-running agents (validated by Marc Nuri dashboard research — context % is the key health metric)
- `state/` folder provides all the inter-run continuity needed for most agents
- `persistent` is available for interactive agents or agents where conversational reasoning across ticks is the core value

**Alternatives:**
- **Always oneshot** — simpler but removes the option for genuinely persistent agents.
- **Always persistent** — context bloat, eventual failure. Not viable for 24/7 agents.
- **Auto-compact on overflow** — OpenClaw's approach. Valid for persistent mode but doesn't change the default.

---

## ADR-022: OWNER.md Convention — No Formal Audience Types
**Date:** 2026-03-17 (revised 2026-03-19)
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** Initially designed a formal `audience.type` field in agent config (personal/service/dedicated) to handle different user profiles. On reflection, all current agents are personal tools — the distinction is premature and adds complexity to `agent.json` for hypothetical use cases.

**Decision:** Drop formal audience types. Keep a single convention:

- **`OWNER.md`** at `~/.autonomos/OWNER.md` — describes the owner (Terry). Injected into the systemPrompt for all agents by the runner.
- If a specific agent serves a different person, the agent author handles this in the agent's own `.claude/CLAUDE.md` or drops a `persona.md` in the agent folder. No framework support needed.
- Multi-user / service agent patterns are punted entirely.

**Rationale:**
- All agents Terry builds now are personal. "Service" and "dedicated" types are solving problems that don't exist yet.
- OWNER.md covers 100% of current use cases — agents know who Terry is.
- Outward-facing agents (if ever needed) can define their own user context in CLAUDE.md. This is agent-specific logic, not platform logic.
- Keeps `agent.json` minimal — no `audience` field.

**Alternatives:**
- **Formal audience.type field** (original ADR-022) — three types with different USER.md and session allocation strategies. Over-engineered for a personal tool.
- **No OWNER.md at all** — agents wouldn't know who they serve. Simple but misses easy personalization.

---

## ADR-023: VLA Runtime — Punted to Roadmap
**Date:** 2026-03-19
**Decided by:** Terry
**Source:** Claude Code research session (agent-platform-research branch)

**Context:** autonomOS has an aspirational "Robot Path" for persistent physical agents (home automation, robotics). This requires a fundamentally different runtime from the Claude Agent SDK: VLA (Vision-Language-Action) models run at 10–50Hz, output continuous motor commands, and require in-model temporal state (recurrent architectures or sliding frame windows) rather than software-managed context windows. The `AgentRuntime` abstraction (ADR-019) was designed to make this swap possible.

**Decision:** Punt VLA runtime to roadmap. The `AgentRuntime` interface is the seam — a `VLARuntime` implementation would replace `query()` with a high-frequency sensorimotor loop and a VLA-capable model (RT-2, π0, or equivalent). No work on this until the Dev Path agent platform is working end-to-end.

**Key architectural difference documented:**
- Text LLM agents: discrete episodic (cron ticks, context window as memory, software-managed history)
- VLA agents: continuous real-time (10–50Hz, in-model recurrent state, physical grounding)
- Visual memory for VLA: CLIP embeddings in vector DB (LanceDB) — no well-known OpenClaw-equivalent exists yet for visual-memory agent orchestration

**Rationale:**
- Robot path is aspirational. Dev path is the immediate priority.
- The `AgentRuntime` abstraction already provides the architectural seam — no premature VLA work needed now.
- VLA frameworks (RT-2, π0, OpenVLA) are rapidly evolving. Better to wait for the ecosystem to stabilize.

**Alternatives:**
- **Build VLA runtime now** — premature. No hardware to test against, no immediate use case.
- **Ignore robot path entirely** — the `AgentRuntime` abstraction costs nothing to keep and preserves the option.

---

## ADR-024: Persist Exited Sessions Instead of Deleting
**Date:** 2026-04-07
**Decided by:** Terry + TeamLead agent
**Source:** Claude Code session (autonomOS team lead discussion)

**Context:** When an agent exits (PTY process ends naturally or via kill), `onExit` calls `removePersistedSession()` which deletes the entry from `sessions.json`. This means exited agents vanish completely — their org chart position, template, manager, and name are all lost. Terry wants the ability to bring back exited agents without re-configuring everything.

**Decision:** Instead of deleting sessions from `sessions.json` on exit, mark them with `status: "exited"`. The dashboard shows exited sessions in a grayed-out/collapsed state. Users can manually resume them via a `POST /api/sessions/:id/resume` endpoint. Only an explicit permanent delete action truly removes the entry. `resumePersistedSessions()` on boot skips exited entries (don't auto-resume).

**Rationale:** Preserves all session metadata (template, manager, project, name) across exits. Makes agents feel persistent rather than ephemeral. Also naturally fixes a pre-existing race condition (see ADR-025).

**Alternatives:**
- **Separate "archive" storage** — unnecessary complexity, same data structure works with a status field.
- **Prompt before deleting** — disruptive UX, doesn't help with programmatic kills.
- **Auto-resume all on boot** — unwanted. Some agents exit intentionally.

---

## ADR-025: Fix restartAllSessions onExit Race Condition
**Date:** 2026-04-07
**Decided by:** Terry + BugFixes agent
**Source:** Claude Code session (discovered during PR #109 testing)

**Context:** `restartAllSessions()` sets `shuttingDown = true`, kills PTYs, calls `sessions.clear()`, then sets `shuttingDown = false` before respawning. PTY `onExit` handlers fire asynchronously — by the time they run, `shuttingDown` is already `false`, so they call `removePersistedSession()` which deletes entries that newly spawned sessions just wrote. Result: `sessions.json` ends up empty after restart-all.

**Decision:** Fix falls out of ADR-024 — `onExit` now sets `status: "exited"` instead of removing. No removal means no race. During `restartAllSessions()`, the new `createSession()` calls overwrite the exited entries via `persistSession()`'s upsert logic, so the status correctly becomes active again.

**Rationale:** Simplest fix that eliminates the race entirely rather than adding synchronization complexity.

**Alternatives:**
- **Track pending exits with a counter** — adds complexity, requires async coordination.
- **Check if session ID is still in the map before removing** — fragile timing dependency.

---

## ADR-026: Native Cron Scheduler with Croner
**Date:** 2026-04-14
**Decided by:** Terry + CronDesign agent (research + design session)
**Source:** Claude Code session (cron scheduler feature implementation)

**Context:** autonomOS needs a scheduling system so agents can create recurring and one-time tasks. Claude Code has three scheduling tiers (session-scoped CronCreate, desktop SKILL.md, cloud Triggers) but none integrate with multi-agent orchestration. Competitors (Devin, Zo, Cursor) have limited scheduling. The scheduler needs to integrate with the existing gateway, templates, and MCP tool systems.

**Decision:** Server-side cron scheduler using Croner v10 (timer-based, not polling). Each enabled schedule gets its own `Cron` instance. Schedules stored as JSON files in `~/.autonomos/schedules/`, run history as append-only JSONL. Two execution modes: `isolated` (headless `claude -p` child process) and `agent:<name>` (inject prompt via gateway). Six MCP tools for CRUD + trigger. Dashboard pane for monitoring — no create button (agents create schedules, dashboard controls them). Overlap policies (skip/allow), global concurrency limits, startup catch-up for missed runs.

**Rationale:** Croner is zero-dep, TypeScript-first, used by OpenClaw. Timer-based scheduling (no polling) is more efficient. File-based storage follows the templates pattern. The "agents create, dashboard controls" pattern matches autonomOS's philosophy. Overlap policies (inspired by Temporal) prevent runaway agent scheduling. Gateway integration for `onComplete` delivery is a unique differentiator vs. competitors.

**Alternatives:**
- **Polling-based scheduler** — less efficient, harder to handle timezones correctly.
- **Database-backed storage** — overkill for local-first tool, files are simpler and human-readable.
- **node-cron** — less maintained, no timezone support, no previous-run computation.
- **Dashboard-based schedule creation** — goes against autonomOS philosophy where agents are the creators.

---

## ADR-027: Provider-aware hook event translation; Codex status-blind for now
**Date:** 2026-04-23
**Decided by:** Terry + MultiProviderFix agent
**Source:** Claude Code session (post-PR #133 bug fix)

**Context:** PR #133 shipped `AgentProvider` with Codex + Gemini backends, but neither produced working end-to-end agents in the dashboard. Two distinct failures:
- **Gemini** — hooks fire correctly (the settings file at `~/.autonomos/gemini-settings.json` is written and loaded), but Gemini emits native event names (`BeforeTool`, `AfterAgent`, `PreCompress`, etc.) that fall through the CC-shaped switch in `deriveStatus()`. Status stays frozen.
- **Codex** — the `--enable codex_hooks` flag toggles a feature that is `under development` per `codex features list`. No hooks config format exists in Codex today (`~/.codex/hooks.json` is not a real file), and autonomOS never wrote one anyway. The flag is a no-op.

**Decision:**
1. Add an optional `normalizeEvent(raw) → raw | null` method to `AgentProvider`. The hook route looks up the session's provider and translates the event before calling `deriveStatus`. CC has no translator (identity). Gemini provides a name+field translator (e.g. `BeforeTool → PreToolUse`, `AfterAgent → Stop`, Gemini's `ToolPermission → permission_prompt`).
2. Drop the dead `--enable codex_hooks` flag. Mark Codex capabilities honestly (`hooks: { eventCount: 0, perSession: false, requiresSetup: false }`). Codex agents spawn, respond, and can call MCP tools, but do not drive dashboard status — they show "running" until they exit. Accept this until Codex ships stable hooks OR we integrate with `codex app-server --listen ws://` (WebSocket JSON-RPC).

**Rationale:** The minimum fix. The translator approach keeps `deriveStatus()` untouched (no state-machine refactor), adds one optional method per provider, and scales linearly as providers are added. The canonical-event-bus refactor (decouple transport from semantics; define provider-neutral event vocabulary) was considered but rejected as premature abstraction: three providers, only one of which needs translation, and one of which can't emit events at all no matter what shape we define. Revisit if the provider set grows to 4+.

**Alternatives:**
- **Canonical event vocabulary owned by autonomOS** (`session.start`, `turn.start`, `tool.start`, …) with per-provider adapters mapping native → canonical. Cleanest long-term architecture, but ~5x the code for the same user-visible outcome today.
- **Per-provider `deriveStatus()` strategies.** More flexibility per provider, but duplicates state-machine logic and risks status vocabulary drift across providers.
- **Codex `app-server` WebSocket integration.** The correct long-term path for Codex status — OpenAI ships TS bindings and JSON schema generators for the protocol. Deferred to a later plan; current work is not in that direction.
- **PTY output scraping for Codex.** Tail `~/.codex/log/codex-tui.log` or scrape terminal output. Fragile, coupled to internal format.

**Lesson during QA — semantic mismatch on `PreCompress`:**
Initial mapping included `PreCompress → PreCompact`, justified by upstream docs ("PreCompress fires before history summarization"). Live QA showed every Gemini turn flashing the dashboard into "compacting" status, even when no compression was happening. Reading `gemini-cli-core/services/chatCompressionService.ts` revealed that `PreCompress` fires *unconditionally* at the start of every turn as a "we're entering the compression decision tree" hook — the threshold check that decides whether to actually compress runs *after* the hook. That's structurally different from CC's `PreCompact`, which only fires when compaction is actively starting. There's also no `PostCompress` counterpart in Gemini, so we couldn't model the start/end pair anyway. Fix: drop `PreCompress` from `GEMINI_TO_CC_EVENT` and add to `INTENTIONAL_DROPS`. Generalization: for translator-based provider abstractions, **vendor docs give you event *names*; only vendor *source* gives you event *firing semantics*** — verify both before mapping.

---

## ADR-028: Desktop App is a Thin Client, Not a Server
**Date:** 2026-05-18
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Claude Code session (Phase 1B.2 design — post-1B.1 PTY corruption bug)

**Context:** PR #172 (Phase 1B.1) shipped a desktop app that spawned `autonomos-server` as an Electron child process. Real-world test exposed a destructive race: when both the desktop-spawned server AND the Phase 1C-installed LaunchAgent server ran simultaneously, both attached to the same `~/.autonomos/` state and the same PTY children, corrupting session state and breaking active Claude Code agents. The root cause was conflating *transport* (how UI talks to server) with *supervision* (what keeps the server alive). Investigation of the broader landscape revealed: (1) n8n Desktop was sunset in 2023 because the "bundled-server-with-GUI" model loses to either Cloud or self-hosted server in the long run — users who want background work converge on a real server; (2) Terry's actual usage is "deploy autonomos-server to forge + access via web," structurally identical to n8n self-hosted; (3) the AI/agent desktop category today is dominated by bundled-stack designs (AnythingLLM, LobeChat, Cmux) that share n8n's structural problem; (4) the database-tooling lineage (MongoDB Compass, Lens, Beekeeper Studio, Open WebUI Desktop) has a well-validated alternative — pure thin Electron client over an independently-supervised daemon — that survives users graduating from local to remote deployment.

**Decision:** The autonomOS Desktop app is a **pure thin Electron client**. It does NOT embed or supervise a server in production builds. It connects to one or more `autonomos-server` daemons — each supervised independently by launchd (macOS) or systemd-user (Linux) per Phase 1C. The desktop manages a list of `Connection` records (id, name, type: local|remote, url, encrypted-token), with the local connection synthesized at runtime from `~/.autonomos/server-state.json` rather than stored in the list. Multi-connection is first-class with VS-Code-Recent-Folders-style sidebar switching. First-launch UX offers "Set up local server on this Mac" (which invokes the existing Phase 1C `autonomos install-service` from the bundled server in `extraResources/server/`) AND "Connect to existing server" (paste URL + token). A custom `autonomos://connect?url=...&token=...` URL scheme provides the magical-feel "click after install.sh prints it" bridge between server install and desktop pairing. Quitting the desktop NEVER touches any server — daemons stay running across desktop quits, reboots, and uninstalls. Auth uses bearer tokens stored via Electron `safeStorage` (Keychain on macOS, libsecret on Linux, DPAPI on Windows). PR #172 is closed unmerged because its architecture is incompatible with this design.

**Rationale:**
- **Fixes today's bug structurally.** Two servers competing for the same state cannot happen when the desktop never runs a server.
- **Aligns with Phase 1C investment.** The LaunchAgent / systemd-user supervision shipped in #170 is the *correct* daemon supervisor; the desktop should be a client of it, not a competitor.
- **Matches the dominant pattern in the analogous category.** MongoDB Compass, Lens, Beekeeper Studio, and Open WebUI Desktop all use this pattern. Open WebUI Desktop (LLM-tool space) is a near-perfect precedent.
- **Decouples lifecycles correctly for an agent platform.** Agents must run while the user is asleep. This means server-supervision belongs to the OS init system, not to a GUI session. VS Code Remote-SSH does the opposite (vscode-server dies with the editor session) because editors have no work to do without the user — agents do.
- **Multi-connection is the right primitive.** Terry uses both forge (remote) and may use a local Mac server. The desktop being able to hold both, like VS Code holding multiple workspaces, is the survival pattern.
- **`autonomos://` deep links bridge the "two products" feel without coupling.** install.sh prints the URL, user clicks it, the OS launches the desktop with the URL as argv. ~30 LOC of code, zero coupling between server and desktop releases.

**Alternatives considered:**
- **Sandbox the desktop app to a separate state dir** (Option A from the design discussion). Fast (~30 min fix), but splits Terry's world — agents on forge wouldn't appear in the local desktop view. Rejected because the value proposition of autonomOS is a *unified* command center across deployments.
- **Shared state + lockfile mediation** (Option B). Conceptually clean but unprecedented in the macOS app landscape — no production GUI+daemon app on macOS uses this pattern. Specifically dies on PTY ownership (node-pty FDs can't be handed off across processes), making the lockfile only advisory and the bug always-possible if one process misbehaves.
- **Bundled daemon with adoption logic** (Option D, an earlier draft). Cleaner than B but still has the desktop responsible for daemon lifecycle in some scenarios. Open WebUI Desktop researched this approach and found it more brittle than pure client mode. Discarded in favor of full Option E.
- **Pure-SaaS thin client (no local mode)** (Option C-strict). Cleanest for forge users, but excludes anyone trying autonomOS without a server first. The n8n autopsy shows those users churn, BUT the addition of bundled `install-service` makes the friction trivial — a single click in the Welcome flow. So we keep the local-server option without inheriting the n8n trap.
- **SSH-based remote install from the desktop.** Considered: have the desktop SSH to a remote box and run install.sh there. Rejected: massive scope creep (SSH credentials in the app, sudo prompt handling, distro detection), no reference app does this, and `curl install.sh | sh` + paste-URL+token is already 30 seconds.

**Implications:**
- **PR #172 closed unmerged.** Branch `terry/phase-1b1-electron-shell` can be deleted. Salvageable bits (electron-builder.yml, entitlements, smoke-test harness) carried forward into Phase 1B.2 branch via fresh writes.
- **Phase 1B.4 (electron-updater) becomes simpler.** Desktop and server upgrade independently — `autonomos upgrade` updates the daemon, electron-updater updates the desktop, neither blocks the other.
- **No tray/menubar mode in 1B.2.** Out of scope; reconsidered if user demand surfaces.
- **Zero server-side changes required.** Original draft of this ADR claimed a "~10 LOC server-side addition" to write a `server-state.json` file. Audit (a7e63bbfa230a898f) caught that `packages/server/src/pid-file.ts` already writes the identical schema (`{pid, port, version, startedAt}`) to `~/.autonomos/autonomos.pid` at every daemon boot. The desktop reads from there. The 1B.2 PR ships purely client-side.

**Post-design audit corrections (2026-05-18):**
- **Deep links MUST gate on explicit user gesture, not pre-fill-then-Enter.** A malicious webpage can fire `window.location = "autonomos://connect?url=evil.com&token=stolen"`; macOS routes the URL to autonomOS.app with no browser confirmation dialog. The Add Connection modal opened from a deep link MUST require an explicit "Connect" click; default focus must not be on the submit button. HTTP non-loopback URLs show a red warning banner. Deep-linked connections never auto-become `defaultConnectionId`. Helper text in the Welcome screen explicitly tells users where deep links come from (terminal output, NOT webpages).
- **Token validation uses an authenticated endpoint.** Earlier draft used `GET /api/host`, which is auth-bypassed (liveness probe). Replaced with `GET /api/system/version` which requires `Authorization: Bearer ${token}` and returns `{version, platform, arch}` — a 200 confirms reachability AND token validity in one call.
- **Per-connection isolation uses `BrowserWindow` (or `WebContentsView`), not the deprecated `<webview>` tag.** Cookies set via `session.fromPartition(\`persist:connection-${id}\`).cookies.set(...)`, NOT `session.defaultSession` (which would leak across connections). Open WebUI Desktop's actual code uses `BrowserWindow`, despite an earlier misread of their pattern.
- **Single-instance lock is a top-level requirement**, not just a deep-link feature. Acquired in `bootstrap()` before any window creation or config touch. Without it, two desktop processes pointing at the same `tokens.dat` / `config.json` torn-write — the Promise-chain lock in `store.ts` is process-local.
- **`tokens.dat` is written with mode `0o600` and its parent dir with `0o700`.** Consistent with the rest of autonomOS, which enforces this on every token-bearing file (`auth.ts`, `settings.ts`, `schedules.ts`, `templates.ts`, `scheduler.ts`).

**Design doc:** `docs/research/desktop-as-thin-client.md`

