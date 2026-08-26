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

**Update (2026-06-29, ADR-051):** The "package as Electron desktop app later" clause is cancelled — see ADR-051. The web-first core (the server IS the product; the UI layer is swappable; start light and add heavier shells only when needed) is *reaffirmed*: the heavier Electron shell didn't earn its keep, so the canonical client reverts to web-first + PWA. The `docs/research/desktop-shells/` analysis above is retained as the historical justification for the web-first decision.

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

**Update (2026-07-25, ADR-059):** Superseded — the feature is removed entirely, including all three layers above plus `GET /api/files/read` and `WS /ws/files/watch`. It had silently regressed twice (the dockview default in #263 left `openPreview` tearing down the whole dock; the hierarchy-sidebar default in #249 left an open preview with no sidebar row) and carried zero test coverage, so both regressions landed green. The "reusable building blocks" rationale did not hold: `/api/files/read` acquired no second consumer in four months. The rejected **"split pane in SessionPane"** alternative above remains the starting point if a working version is ever wanted — with test coverage this time, not a revert.

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

**Update (2026-06-29, ADR-051):** The Electron thin-client app this ADR designed is cancelled — see ADR-051; `packages/app/` and the design doc above (`desktop-as-thin-client.md`) are removed. What stays: server-supervision belongs to the OS init system (launchd/systemd-user, finished in ADR-050), and the pid-file discovery this ADR relied on. We removed the desktop entirely rather than make it a client of the daemon.

---

## ADR-029: Desktop Embeds Built-in Server (Reverses Part of ADR-028)
**Date:** 2026-05-25
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Claude Code session (Phase 1B.2 testing — discovered after the thin-client architecture was working end-to-end)

**Context:** Phase 1B.2 shipped the pure thin-client architecture per ADR-028: Desktop never runs a server, always connects to a daemon supervised by launchd/systemd-user (or a remote server). Worked correctly — drag, multi-window, clean quit-cleanup, all functioning. Then Terry pushed back on the UX: requiring a separate `curl install.sh | sh` step before the Desktop is usable is a substantial friction barrier for new users. Comparable apps that ship Built-in functionality (Docker Desktop, OrbStack, Postgres.app — Built-in everything; the GUI is the runtime) achieve a "open the app, it just works" experience that pure thin-client architectures cannot. The pure-thin-client design from ADR-028 is *correct* for forge-style deployments but *wrong* for a new-user-first-launch UX. We need both: zero-friction Built-in mode for new/casual users, AND the existing thin-client mode for users who already have a daemon or want to connect to a remote server.

The original PR #172 / Phase 1B.1 attempt at an embedded server failed because of a destructive PTY corruption race: two servers (the embedded child AND a separately-installed LaunchAgent daemon) attached to the same `~/.autonomos/` state simultaneously. ADR-028 over-corrected by banning embedded mode entirely. ADR-029 reintroduces embedded mode WITH a mutual-exclusion contract that prevents the original race.

**Decision:** The autonomOS Desktop app supports **two modes**, mutually exclusive on any single Mac for any single `AUTONOMOS_CONFIG_DIR`:

1. **Built-in:** The Desktop spawns `autonomos-server` as an Electron child process at app launch. The server lives + dies with the Desktop process. Agents pause when the Desktop quits (state persists on disk; resumed next launch via `claude --resume` per the L1 persistence model from Phase 1A.1 design notes). This is the **default** mode at first launch for a user with no existing daemon.

2. **Server:** The Desktop is a pure thin client over an `autonomos-server` reachable at a URL+token. The server may be a launchd/systemd-user daemon on this Mac (set up via `autonomos install-service`) OR a remote server (forge, VPS). From the Desktop's perspective these are **the same mode** — both are "connect to a URL." The distinction "local persistent vs remote" exists only in the install flow (where the user runs `curl install.sh`) and the UI label (e.g. "This Mac (Always-on)" vs "forge"). Internally a `Connection` is `{ id, name, url, token }` regardless of where the URL points.

**Mutual exclusion contract** (the fix for the PR #172 PTY race):

- The pid file at `~/.autonomos/autonomos.pid` (already shipping from `packages/server/src/pid-file.ts`) is the single source of truth for "is there an owner of this config dir?" Format: `{ pid, port, version, startedAt }`.
- Any process that wants to start a server (Desktop Built-in, `autonomos start` CLI, LaunchAgent) must atomically claim the pid file. If a live owner exists (pid alive via `process.kill(pid, 0)` AND port responsive on `/api/system/version`), the new process MUST NOT start its own server. Instead:
  - Desktop in Built-in mode → switches to thin-client mode, connects to the existing server at `localhost:<that-port>`.
  - `autonomos install-service` → refuses with a clear error message instructing the user to quit the Desktop first.
- Stale pid file (pid dead OR port unresponsive) → cleaned up and overwritten.
- On clean shutdown, the owning process removes its pid file.

**Migration paths between modes** (in-app, no Terminal required):

- **Built-in → Server (persistent local):** Settings panel toggle *"Keep autonomOS running in the background"* → ON. Triggers in-process `autonomos install-service` invocation, which sets up the LaunchAgent / systemd-user service. The Built-in server child is gracefully shut down; the LaunchAgent picks up the same `~/.autonomos/` state. Desktop reconnects as a thin client to the new daemon. Progress is shown via an in-app dialog (no Terminal output).
- **Server (persistent local) → Built-in:** Same toggle → OFF. Uninstalls the LaunchAgent via in-process `autonomos uninstall-service`. Desktop spawns a Built-in server on its next agent-needing action.
- **Quit-time prompt:** when in Built-in mode and quitting with running agents, a non-modal banner offers: *"Make autonomOS Server always-on"* (one-click migration to persistent mode) or *"Quit anyway"*. Power-user graceful path without requiring Settings panel discovery.

**UI vocabulary** (no engineering jargon exposed to users):
- "Built-in" = embedded mode (Desktop owns the server's lifecycle).
- "Always-on" or "Persistent" = LaunchAgent/systemd-user mode.
- "Remote" = HTTP connection to another machine.
- Never expose "daemon", "launchd", "embedded", or "thin client" in UI copy.

**First-launch UX:** zero-friction. No Welcome screen for a brand-new user. The Desktop boots into a brief splash ("Starting autonomOS…", ~1-2s while the Built-in server comes up), then the dashboard appears. The Welcome screen is now reserved for "Add another Server" flows from the Connection sidebar.

**Connection sidebar:** retained from ADR-028's design. Even with Built-in being the dominant path, power users with multiple servers (this Mac + forge) appreciate the multi-window switching. Collapsed by default when only one connection exists. "This Mac" is always pinned at the top with a subtitle indicating its mode ("Built-in" or "Always-on").

**Rationale:**
- **Fixes the ADR-028 UX friction without re-introducing the PR #172 bug.** The mutual-exclusion contract (atomic pid-file claim + liveness check) structurally prevents two servers from ever competing for the same `~/.autonomos/` state. The bug was caused by ADR-028's predecessor lacking this contract, not by embedded mode itself.
- **Matches Docker Desktop, OrbStack, Postgres.app.** Those apps own everything in-process for casual users AND offer an "always-on" upgrade path for power users. Their users describe this as "magic." Our Phase 1B.2 thin-client requirement is comparatively friction-heavy.
- **Preserves the thin-client model for everyone who already wants it.** Forge users, anyone with an existing LaunchAgent, anyone connecting to a remote server — these flows are unchanged. ADR-029 is **additive**, not a replacement.
- **Persistent-local and remote collapsing into one "Server" mode is architecturally clean.** Both are `{ url, token }`. The Desktop's connection-handling code path is one path, not two.
- **The quit-time "Make always-on" prompt is a Trojan horse for the right behavior.** Users who run agents long enough to hit the "agents will pause" warning are exactly the users who benefit from persistent mode. The UI catches them at the right moment.

**Alternatives considered:**
- **Three modes (Built-in, persistent-local, remote).** Initially proposed; collapsed into two when Terry observed that persistent-local and remote are architecturally identical from the Desktop's perspective.
- **Stick with pure thin-client (ADR-028).** Rejected because the first-launch friction is a genuine product-experience problem. n8n Desktop was sunset partly because casual users couldn't get started fast enough — ADR-028's predecessor was making the same mistake.
- **Two modes with totally separate UI surfaces.** Considered: "Local mode" tab vs "Connections" tab. Rejected because users don't think in modes; they think in "where is my work running." Unifying persistent-local and remote into one "Server" concept is the user-facing simplification.
- **Built-in default + "install-service" as the only persistence path (no in-app toggle).** Rejected: discoverability is poor. The Settings toggle + quit-time prompt are the affordances that surface the persistence option to users who'd benefit.

**Implications:**
- **Phase 1B.2's thin-client code stays.** It IS the implementation of the "Server" mode. Built-in mode adds a new code path; remote mode is unchanged.
- **The webview drag, multi-window, quit-cleanup work from Phase 1B.2 all carries forward.** No rework of those pieces.
- **PR #172's salvageable code re-enters circulation.** The `server-supervisor.ts` from that PR (which spawned the embedded server) is the seed of the new Built-in implementation, but rewritten with the mutual-exclusion contract.
- **Server-side change required.** `packages/server/src/pid-file.ts` already writes the schema; we need to add an atomic-claim helper using `open(O_CREAT | O_EXCL)` (or equivalent) so two processes racing to claim the pid file can't both win. ~30 LOC.
- **CLI changes required.** `autonomos install-service` and `autonomos start` must check the pid file and refuse with a helpful error if the Desktop already owns the config dir.
- **Pure-thin-client ADR-028 is partially superseded.** ADR-028 said "Desktop never embeds." ADR-029 says "Desktop CAN embed, under a mutual-exclusion contract." The other ADR-028 elements (multi-window, cookie auth, deep links, audit fixes, etc.) all remain in force.

**Design doc:** `docs/research/desktop-embedded-server.md`

**Update (2026-06-29, ADR-051):** The Electron Built-in/embedded server mode is cancelled — see ADR-051; `packages/app/`, the server's `--embedded` flag + `embedded-mode.ts`, and the design doc above (`desktop-embedded-server.md`) are removed. The **mutual-exclusion contract (atomic pid-file claim + liveness check) STAYS** — it still prevents two daemons from racing on the same `~/.autonomos/` state, independent of any desktop. (The shared real-spawn integration harness that used `--embedded` for ephemeral-port readiness was rewritten to parse the server's standard "listening on" startup log line, and renamed `helpers/test-server.ts` since it was never Electron-specific.)

---

## ADR-029-follow-up: Drop `autonomos://` deep-link handler
**Date:** 2026-05-27
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Post-merge cleanup discussion after PR #173

**Context:** ADR-028 (and its post-design audit) called for an `autonomos://connect?url=...&token=...` URL scheme so `install.sh` could print a clickable link to pair the Desktop with a freshly-installed server. The handler shipped in PR #173 (Phase 1B.2) along with `setAsDefaultProtocolClient`, an `open-url` listener, a `pendingDeepLinks` argv buffer, and a "Pre-filled from a deep link" warning banner on `AddConnectionModal`. After ADR-029 collapsed the first-launch flow into Built-in mode (no `install.sh` needed for the default user), the deep-link path became a vestigial bridge: it only helps users who already chose to install a remote/Always-on server, who already have a terminal open with the URL+token printed in it.

**Decision:** Remove all `autonomos://` deep-link code and registration. The "Add a server" modal continues to accept paste-in URL + token; the `autonomos serve --print-url` CLI continues to print copyable pairing strings. Deep links are **deferred indefinitely** — not deprecated for one release, just removed. If user demand materializes (someone explicitly asks for "I want install.sh to launch the Desktop with a click"), revisit.

**Rationale:**
- **Phishing surface > utility.** A malicious webpage can fire `window.location = "autonomos://connect?url=evil.com&token=stolen"` and macOS routes the URL to autonomOS.app with no browser confirmation dialog. ADR-028's mitigation (explicit user click, no auto-submit, warning banner for non-loopback HTTP) reduces but does not eliminate the social-engineering risk that a user clicks "Connect" because the modal looks legitimate.
- **The intended-user flow is already <30 seconds without it.** Paste URL + token from `autonomos serve --print-url` into the Add Server modal is one copy + one paste. The "click the magical link" win is shaved off a flow that's already friction-free for the few users who hit it.
- **ADR-029 made the deep-link bridge less load-bearing.** The default user now boots straight into Built-in mode with no install step. The deep-link path was a bridge between "install.sh prints URL" and "Desktop pre-fills the modal" — neither end of that bridge is the dominant flow anymore.
- **Code removed > code kept.** ~80 LOC across `main.ts` (URL_SCHEME import, `pendingDeepLinks` buffer, `open-url` listener, `setAsDefaultProtocolClient`), `shared/constants.ts` (URL_SCHEME, `DEEP_LINK_RECEIVED` IPC), `AddConnectionModal.tsx` (`prefill` prop + warning JSX), and `electron-builder.yml` (`protocols:` registration). One less feature to maintain, one less attack surface in the Info.plist.

**Alternatives considered:**
- **Keep deep links, harden further.** Add a one-time confirmation toast "autonomOS Desktop received a pairing request from `<url>` — is this from your terminal?" before opening the modal. Rejected: adds a step to the flow it was meant to remove, and savvy attackers still social-engineer through it.
- **Remove the handler, keep the constant.** Leaves a half-deleted feature in the tree. Rejected — the constant existed only to be referenced by the handler.
- **Deprecate via flag for one release.** Standard rollout safety, but the feature has no users yet (deep links never made it into `install.sh` output before this drop). Pure code removal is safe.

**Implications:**
- ADR-028's "post-design audit corrections" bullet about deep links is no longer load-bearing. Not deleted — kept for historical context.
- `install.sh` (when it ships) will print URL + token as plain text for copy-paste, not as an `autonomos://` link.
- `Info.plist` no longer claims the `autonomos://` scheme — no chance of accidental routing if a stale Desktop install lingers on disk after this version.
- Phase 1B.2.4 (deep-link phase from the original Phase 1B.2 plan) is dropped from the roadmap. Phase numbering is not renumbered; the gap is intentional historical record.
- Also dropped the unused `SERVER_STATE_FILENAME = "server-state.json"` constant from `packages/app/src/shared/constants.ts`. ADR-028's post-design audit established that the daemon pid file at `~/.autonomos/autonomos.pid` (already shipping from `packages/server/src/pid-file.ts`) is the canonical discovery target; the `server-state.json` constant was vestigial from an earlier draft and had no importers.

**Single-instance lock is preserved.** ADR-028's audit emphasized that `app.requestSingleInstanceLock()` is a top-level requirement, not a deep-link feature — without it, two Desktop processes would torn-write `tokens.dat` / `config.json`. The lock + the `second-instance` handler (now reduced to "bring window forward / open Welcome") stay in `main.ts`.

**Update (2026-06-29, ADR-051):** Moot — the entire desktop app (and its `autonomos://` deep-link surface) is removed by ADR-051. Kept for historical record.

---

## ADR-030: Desktop "Try it out" (ephemeral) mode
**Date:** 2026-06-05
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Claude Code session — discussion after #178 (Built-in server reachability fix). Terry: "Maybe for the DMG app, do you think it makes sense for you to allow users to essentially create configurations at a different path or use a temporary one?" → narrowed to ephemeral-only after pushback on full profile scope.

**Context:** Built-in mode (ADR-029) requires a brand-new user to commit to having `~/.autonomos/` populated on their first click. That's fine for users who plan to stick with the app, but it creates friction in three scenarios: (a) a user who just wants to "kick the tires" before committing, (b) demos / sharing the .app with a teammate, (c) our own QA — testing a new build without polluting prod state. We already have `AUTONOMOS_CONFIG_DIR` for dev-side isolation (`make dev`); what's missing is a UI surface that exposes it as a first-class capability.

A separate motivator: tonight (#178) we shipped a Built-in mode reachability fix that should have been caught during initial Phase 1B.2 testing. It wasn't, partly because there was no easy "spin up a fresh isolated autonomos and see if it works" path in the app. A sandbox UI makes that kind of QA the default, not an afterthought.

**Decision:** Add a fourth card to the Welcome screen — **"Try it out"** — that spawns a Built-in server with `AUTONOMOS_CONFIG_DIR=$TMPDIR/autonomos-ephemeral-<uuid>/` and a freshly generated random token. Nothing reads from or writes to `~/.autonomos/`. On Desktop quit the temp dir is `rm -rf`'d. On Desktop boot any leaked `autonomos-ephemeral-*` dirs older than 1 hour are cleaned up (best-effort recovery from crashes; macOS auto-cleans `$TMPDIR` every ~3 days anyway).

**Scope (explicitly minimal):**
- One Welcome card, three IPC lines, one server-side auth.ts change.
- **No named profiles.** Multi-profile UI was considered and rejected for v1 — "too much" per Terry. Ephemeral covers the dominant use case (try-then-commit or try-then-discard) without the cognitive load of profile management.
- **No persistent state.** The temp dir is the entire state surface. Quit = gone.
- **No title-bar badge yet.** The Welcome card name ("Try it out") is the user's mental model; we'll add a badge if it turns out users routinely confuse try-mode with real-mode.

**Token isolation contract:**
Pre-this-ADR, `auth.ts` hardcoded the token file to `~/.autonomos/token` regardless of `CONFIG_DIR`, per a comment that read "the auth token should be shared — one token for the user's machine." That made sense for worktree-based dev isolation (one user, multiple worktrees, shared token) but breaks the moment a profile is supposed to be isolated. The new behavior: `auth.ts` looks for `<CONFIG_DIR>/token` first, falls through to `~/.autonomos/token` only when CONFIG_DIR is non-default AND no per-config token exists (so existing worktree-dev setups don't surprise the user with auth failures). Default CONFIG_DIR resolves to the same path as before — fully backwards-compatible.

**Rationale:**
- **Composes with everything that already exists.** `AUTONOMOS_CONFIG_DIR` was already honored by the server; the mutual-exclusion contract (ADR-029) uses CONFIG_DIR-relative pid files so different config dirs can coexist; the #178 port/token fix makes spawned CC sessions correctly phone home to whichever port the ephemeral server bound to. No new mechanisms, just a new UI surface.
- **Solves the QA gap.** Every future Built-in / dashboard / spawn-path change should be testable by "open the DMG, click Try it out, exercise the feature, quit." That's the workflow that should have caught #178 earlier.
- **Onboarding win.** Distribute the .app to a colleague, they click Try it out, poke around for 10 minutes, quit, no residue on their machine. Removes the "do I really want to commit?" mental tax from first-contact.
- **Surfaces an isolation contract we already needed.** The token-in-CONFIG_DIR change is the right architecture for future profile support too — when we eventually want named profiles, the building block is in place.

**Alternatives considered:**
- **Full multi-profile UI (named + ephemeral, switcher, settings tab).** Considered first. Rejected explicitly: "Let's just get an ephemeral version of this. No need for profile complications. It's a bit too much." Ephemeral is the high-leverage subset; named profiles can be added later with no architectural rework.
- **Sandbox window served from a separate process (not the Built-in server).** Would require a second server binary or sandboxed runtime. Massive overkill — the same server binary running against a different CONFIG_DIR achieves identical isolation.
- **In-memory state (no temp dir, no disk persistence at all).** Would require a server mode that skips all disk writes (settings, schedules, sessions, templates). Big surface area; defeats the goal of "the server behaves identically to production." Disk-on-tmpdir is structurally the same as disk-on-`~/.autonomos`, just at a different path.
- **Token shared with prod (only CONFIG_DIR isolated).** Considered as a backwards-compat shortcut. Rejected: token-sharing across isolated profiles is exactly the cross-profile auth bleed we want to prevent. The auth.ts fallback handles backwards-compat for non-ephemeral cases.

**Implications:**
- `auth.ts` changes are fully backwards-compatible. Default CONFIG_DIR (`~/.autonomos/`) resolves to the same `~/.autonomos/token` path as before. Existing prod servers, worktree dev setups, and CI all see zero behavior change.
- The same CONFIG_DIR-aware token lookup works for future named profiles (ADR-031, if we ever ship it). The plumbing is sized for the bigger feature; the UI surface is sized for the immediate need.
- `cleanupLeakedEphemeralDirs()` is best-effort and runs at every Desktop boot. If it fails (`$TMPDIR` unreadable), it logs a warning and continues — never a boot-blocker.
- The "Try it out" server is regular Built-in mode pointed at a temp dir, so ALL the regular code paths (gateway, MCP, hooks, scheduler, templates, agent spawning) work identically. Easier to reason about than a separate "sandbox runtime."

**Testing:**
- Unit: `auth-config-dir.test.ts` (4 tests) covers env precedence, per-CONFIG_DIR token read, fresh-token generation, file permissions.
- Integration: booted the server with `env -i HOME=... PATH=... AUTONOMOS_CONFIG_DIR=/tmp/autonomos-try-test --embedded --port=0`. Confirmed (a) server bound to ephemeral port 58099 with no collision against prod 3100, (b) fresh token generated and written ONLY to `/tmp/autonomos-try-test/token` with mode `0o600`, (c) `~/.autonomos/` untouched throughout.

**Update (2026-06-29, ADR-051):** The "Try it out" Welcome-card UI is removed with the desktop app — see ADR-051. The **server-side `auth.ts` CONFIG_DIR-aware token isolation it introduced STAYS** — it is general isolation plumbing (worktree-dev today, future named profiles tomorrow), fully backwards-compatible, and independent of the ephemeral-mode UI that originally motivated it.

**Design follow-ups:**
- Add a title-bar "TRY MODE" badge if users start losing work to surprise-on-quit.
- Add a one-click "Save my Try Mode as a real connection" pathway (export tokens, prompt for confirmation) — turns the ephemeral session into the seed of a regular connection.
- Named profiles (ADR-031), if/when we have a real use case. The CONFIG_DIR + auth-token plumbing is already ready for it.

---

## ADR-031: Professional release pipeline (changesets + universal CI DMG)
**Date:** 2026-06-06
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Claude Code session — "revamp releases to industry standard, boil the ocean"
**Status:** Drafted by feature worker, pending team-lead review. (Numbering note:
ADR-030's follow-ups informally forward-referenced "ADR-031" for *named profiles*;
that feature is unbuilt and speculative, so this ADR claims ADR-031 for the
release pipeline — the decision actually being made. Named profiles, if ever
built, take a later number.)

**Context:** Releases were manual and fragile. Versions were bumped by hand-editing
five `package.json` files with `sed`, which produced a real drift (code at `0.0.2`,
last tag `v0.0.1` — the 0.0.2 bump shipped in #177 was never tagged or released).
The macOS Desktop DMG — the primary user-facing artifact — was built **locally on a
developer's Mac, never in CI, never validated, and dragged into the release by
hand**. There was no changelog (release notes were GitHub's raw commit dump), no
code signing (Gatekeeper warning on every install), no auto-update, and no written
runbook. The server tarballs were the only professionally-built artifact (CI matrix
+ SHA256SUMS). This repeatedly caused "ship → user finds it broken" cycles.

**Decision:** Adopt the canonical 2026 stack, sequenced as six PRs:

1. **changesets** with a `fixed` group (all packages lockstep to one version),
   `@changesets/changelog-github`, a single root `CHANGELOG.md` (per-package
   changelogs gitignored; `scripts/sync-changelog.ts` promotes each version into
   the root). A `version.yml` workflow maintains the "Version Packages" PR and
   auto-tags `vX.Y.Z` on its merge. **Releasing = merge that PR.**
2. **lefthook + commitlint** — the pre-push hook runs the exact CI gate
   (`biome check packages/ && make check`), encoding "run CI before push" as
   enforcement rather than discipline.
3. **Universal2 DMG built in CI** — the macOS app is one artifact for both Apple
   Silicon and Intel. Bundled Node + native modules (`pty.node`, `impit.node`)
   are `lipo`'d from both arches (built on separate runners). Hard-gated by the
   bundle smoke test and a **real Intel runner** that runs the smoke test
   natively on x64. `release.yml` publishes server tarballs + DMG + ZIP + blockmap
   + `latest-mac.yml` + SHA256SUMS, with the GitHub Release body taken from the
   CHANGELOG.
4. **Code signing + notarization** — Developer ID cert + App Store Connect Team
   API key (`.p8`), `notarize: true` (notarytool, auto-staple). Eliminates the
   Gatekeeper warning.
5. **electron-updater** — in-app auto-update from GitHub Releases, delta downloads
   via blockmap, stable/beta channels.
6. **SLSA provenance** (`actions/attest-build-provenance`, SLSA L2) + this runbook
   (`docs/RELEASE.md`) + this ADR.

**Scope decisions (Terry):**
- **macOS-only Desktop app.** No Linux/Windows desktop. The persistent *server*
  still ships cross-platform (the 4 tarballs + `install.sh` cover Linux + macOS).
- **universal2 from day one** (not per-arch), despite the bundled-Node + native-
  module `lipo` complexity. The mechanism was proven locally before building CI:
  a `lipo`'d fat `.node`/binary loads under both arm64 and x64.
- **changesets over release-please** — explicit per-PR changeset files give
  intentional release control and the `fixed` group matches our lockstep model.

**Rationale:**
- **Fixes version drift structurally** — versions are derived from changesets,
  never hand-edited.
- **The DMG can no longer ship broken** — it's CI-built, smoke-tested, and
  validated on real Intel hardware before any release. This is the structural fix
  for the repeated "ship → broken" cycles.
- **universal2 is the better user experience** — one download, no "which chip do
  you have?" — and electron-updater's feed is simplest with a single artifact.
- **Signing + auto-update are table-stakes** for a product users install and keep.

**Alternatives considered:**
- **release-please** (commit-driven) — rejected: changesets' explicit files +
  `fixed` group fit a lockstep monorepo better, and decouple releases from commit
  message discipline.
- **Per-arch DMGs** — rejected by Terry in favor of universal2, accepting the
  `lipo` work (de-risked locally first).
- **Keep building the DMG locally** — rejected: it's the exact source of the
  unvalidated-artifact problem.
- **semantic-release** — rejected: not monorepo-native; the community monorepo
  plugin is stale.

**Implications:**
- Every user-facing PR now carries a changeset (a small per-PR tax that makes
  releasing fully automatic).
- The Apple Developer Program enrollment ($99/yr) is a hard prerequisite for PRs
  4–5 (signing is required for macOS auto-update to work at all).
- electron-builder stays at 25.1.8 for now (handles universal); bump to 26.x only
  if CI surfaces a universal issue.
- The `validate-dmg.sh` CDP UI test runs `continue-on-error` in CI initially —
  whether Electron+CDP runs on a headless GitHub runner is the one unproven piece;
  it hardens to a gate once confirmed.

**Validation:** universal Node `lipo` (256M fat binary), universal native-module
`lipo` + cross-arch load (real impit arm64+x64), local single-arch DMG build +
full `validate-dmg.sh` end-to-end, `actionlint` clean on all workflows, `make
check` 353/353. CI-only pieces (universal build, Intel native job) babysat through
CI.

**Runbook:** `docs/RELEASE.md`.

## ADR-032: Adopt MIT license
**Date:** 2026-06-09
**Decided by:** Human (Terry) — implemented by License@autonomOS (CC session)
**Source:** Terry's request via CC session, coordinated through TeamLead@autonomOS

**Context:** The repo had no license declaration of any kind — no `LICENSE` file,
the `license` field missing in all six `package.json` manifests, and the README
listing the license as "TBD." Undefined licensing creates friction as the project
moves toward broader distribution (the desktop app in progress, possible public
contributions) and ambiguity for downstream consumers — SBOM scanners, compliance
tooling, and the SLSA provenance pipeline already in flight (ADR-031) all key off a
declared license.

**Decision:** Adopt MIT. A `LICENSE` file at the repo root in canonical OSI/SPDX
form (the canonical "to permit persons" wording — verified byte-for-byte against
the OSI text, not a variant), `Copyright (c) 2026 Terry Lu`, and `"license": "MIT"`
declared in all six `package.json` manifests — including the private root — for
tooling/scanner consistency. README's License section points at the file.

**Rationale:** MIT is the lowest-friction permissive license — minimal
restrictions, broad compatibility, and the form license tooling recognizes out of
the box. Declaring it early, before the contributor base grows, sets a clear
baseline and removes the "TBD" ambiguity.

**Alternatives considered:**
- **Apache-2.0** — its explicit patent grant is defensively valuable, but adds
  NOTICE-file overhead and modest tooling friction; rejected because autonomOS has
  no current patent exposure warranting the complexity.
- **GPL/AGPL** — copyleft would constrain downstream embedding in proprietary
  tooling and runs against the project's personal-tool-first philosophy.
- **Dual-license / source-available** — premature for the current stage.

## ADR-033: Idle-renderer CPU peg-detector gate (Phase 6)
- **Date:** 2026-06-09 — **Decided by:** agent (DesktopApp@autonomOS), approved by Terry (peg-detector approach chosen over CSS-invariants-only and nightly-only)
- **Context:** Issue #176 pegged a renderer at ~195% on an idle Welcome window — driven by the GPU compositor under vibrancy + backdrop-filter, zero JS involved. CDP's `Performance.getMetrics` measures JS timing only and was completely blind to this class of regression. Needed a gate that can't be fooled by the bug's own shape.
- **Decision:** Three layers — (1) broaden the CDP CSS-invariant scan to cover every Welcome element (release-time CDP); (2) extract `macWindowOptions` to an electron-free `window-options.ts` module + unit test asserting it never returns `vibrancy` (every PR); (3) OS-level idle-CPU peg-detector in `validate-dmg.sh` — sample app-tree CPU over 10s via `ps -o time`, fail if any process exceeds 80% of one core (release + dispatch).
- **Rationale:** Defense in depth — deterministic static checks (layers 1-2) catch the known shape on every PR; the OS-level peg-detector (layer 3) catches novel causes. The 80% threshold sits in the wide empty gap between healthy idle (~5-45%) and the bug (~195%), making it robust to shared-runner noise. Dry-run against a clean build measured 0.8% — ~100x margin under threshold.
- **Alternatives considered:**
  - **CSS-invariants-only** — blind to novel GPU/compositor pegs not on the static check list.
  - **Nightly CPU sample** — catches regressions a day late; PR-time signal beats post-merge cleanup.
  - **CDP `Performance.getMetrics`** — JS-timing only, structurally blind to the GPU-compositor class.
- **Soundness note:** Cumulative per-process CPU-seconds require a stable process set across the sampling window. The detector kills any prior-instance Helpers and waits for clean teardown before relaunch, and fails closed on negative delta or `t1 <= 0` (filters race conditions in the sampling).
- **Source:** CC session, Phase 6 of the test-framework redesign.

## ADR-034: Promote validate-dmg CDP check to a hard release gate
- **Date:** 2026-06-09 — **Decided by:** agent (DesktopApp@autonomOS), confirmed by Terry
- **Context:** The DMG end-to-end CDP validation (mount DMG → launch Electron → drive Welcome → Try-it-out → assert dashboard) was added `continue-on-error` pending confirmation it can run on a headless GitHub macOS runner. It had also been failing invisibly without anyone noticing — exactly the "false-pass zombie" class of CI step we try to avoid.
- **Decision:** Make it a hard release gate. Root cause of the failures was the bundled server preflight `exit(1)`ing when no provider binary is on PATH (CI runners have none) → Try-it-out's ephemeral server dies → connection window never opens. Fixed in CI by stubbing `claude` on PATH (matches `smoke-test-bundle.sh`'s approach). Shipped in #196; subsequently extended in #201 (Phase 4) to run on every PR via a reusable workflow.
- **Rationale:** Headless capability confirmed on dry-run 27251279763; a broken first-run flow should block a release, not slip through as observe-only telemetry.
- **Alternatives considered:** Keep observe-only (rejected — a green-looking step that never blocks is the false-pass zombie class we're trying to kill). Add a "is the dashboard reachable" smoke without the full CDP drive-through (rejected as insufficient — the bug was specifically in the Welcome → Try-it-out flow that ad-hoc reachability checks would miss).
- **Known limitation:** The PATH stub means the gate covers only the provider-present first-run path; the no-provider path is a separate known product bug (see follow-up product item: Try-it-out hangs silently when no provider is installed).
- **Source:** CC session, headless-ci-electron investigation. Supersedes the observe-only `continue-on-error` note in ADR-031 (release pipeline).

## ADR-035: Claude Usage requires only a session key (drop org ID)
- **Date:** 2026-06-10 — **Decided by:** Human (Terry), implemented by CloudUsageOrg@autonomOS under DesktopApp@autonomOS lead
- **Context:** The Claude Usage plugin required two credentials in settings: a Claude session key AND a "last active org" UUID. The org field was an unnecessary friction point — particularly noticeable in the desktop-app onboarding flow — and was never strictly needed because `scanner.ts:fetchOrgId` already had a fallback path that resolves the org via claude.ai's bootstrap API using the session cookie.
- **Decision:** Session key is the only required credential. The org UUID is auto-resolved on first use via the existing bootstrap-API fallback, then cached. `claudeOrgId` remains as a deprecated field for back-compat (old `settings.json` parses cleanly; the settings PUT route accept-and-discards it; a stale config value is silently ignored rather than added to the cookie). No migration step.
- **Rationale:** Removes a confusing setup field whose value the system can derive itself. Smaller credential surface for desktop-app onboarding.
- **Alternatives considered:**
  - Keep org as an optional override — rejected; Terry's intent was to remove the field entirely, and the bootstrap fallback covers every case the manual field did.
  - Migrate existing `claudeOrgId` values to the cache on read — rejected; not worth the complexity for a field that resolves cheaply on first call.
- **Source:** CC session, DesktopApp issues sweep. Shipped in #202.

## ADR-036: Prompt delivery receipt + one-shot fallback re-delivery
- **Date:** 2026-06-11 — **Decided by:** Human (Terry, reported the bug + directed the fix), design by DesktopApp@autonomOS lead, implemented by PromptDelivery@autonomOS
- **Context:** `create_agent`'s starting prompt is delivered solely as a CLI arg (`claude … -- "prompt"`). If the auto-trust watcher's blind Enter-burst raced Claude Code's TUI init, the trust dialog never dismissed cleanly and the argv prompt died behind it — the new agent sat idle at an empty input. Intermittent, silently broke multi-agent orchestration.
- **Decision:** Two layers. **(1)** The auto-trust watcher now uses needle-verified retry — re-send Enter only if the same prompt needle is still present after ~500ms, capped — instead of blind staggered bursts. **(2)** A delivery-receipt tracker uses the existing hook relay as ground truth: when a spawn includes a prompt, `SessionStart` without a following `UserPromptSubmit` within a timeout triggers ONE re-delivery via PTY bracketed paste, with dedup guards (re-checks receipt at fire time; skips if the session shows activity). All failure paths surface as `SystemWarning` notifications.
- **Rationale:** The hook stream is the only reliable readiness/receipt signal — CC's TUI rendering is unobservable from outside the PTY. One-shot + dedup because double-submission is worse than a manual nudge.
- **Guard against masking:** The CI integration test asserts the fallback did NOT fire on the happy path — the rescue mechanism cannot hide watcher regressions.
- **Alternatives considered:**
  - Gate "ready" status on `SessionStart` only — rejected; that's observability, not delivery.
  - TUI-prompt-needle detection for delivery confirmation — rejected; the prompt character varies by theme/mode.
  - PTY-only delivery instead of argv — rejected; argv is canonical and works in the common case.
- **Source:** CC session, DesktopApp issues sweep. Shipped in #209. CLAUDE.md "Key Systems" entry added in the same PR.

## ADR-037: Remove Telegram/Discord plugin channels and the inbox-agent routing policy
- **Date:** 2026-06-12 — **Decided by:** Human (Terry), implemented by Cleanup@autonomOS
- **Context:** Telegram and Discord channel integrations shipped under task #41 (ChannelMVP@autonomOS) as 18-line stub adapters plus the supporting plumbing: the `inboxAgent` settings field gating plugin-channel single-poller locks, `claude plugin list` detection, and `telegram://` / `discord://` gateway routing. The adapters were never implemented past stubs and the channels were never used in practice. The `inboxAgent` mechanism existed solely to serve the unshipped channels.
- **Decision:** Remove entirely (PR #213, ~−775 lines). `KNOWN_CHANNELS` narrowed to `server:*` only; `isValidChannelId` rejects plugin IDs; `Platform` type narrowed to `"slack"` (the only remaining adapter, also a stub — see note below). Old `settings.json` keys (`inboxAgent`, `gateway.telegram`, `gateway.discord`, stale `plugin:*` entries in `channels`, stale `routes`) are accept-and-discarded: scrubbed on read with warnings naming dropped entries, dropped on next persist. `server:autonomos` (native MCP inter-agent messaging) verified untouched — it's a different mechanism even though it shares the word "channel."
- **Rationale:** Less surface area, fewer concepts to explain ("keep this clean" — Terry's intent). Dead stubs accrue carrying cost (tests to maintain, settings UI noise, mental overhead for new contributors) with zero offsetting value while the features remain unimplemented.
- **Alternatives considered:**
  - Keep as dormant stubs for future implementation — rejected; no demand and the carrying cost is real.
  - Implement Telegram/Discord properly — rejected; no current use case justifying the work.
- **Note:** Reverses the implementation direction sketched in `docs/research/channel-integration.md`, which is retained as historical context. The Slack adapter stub + the entire gateway-adapter layer (~150 more lines) remain as the only "platform" surface after this change — flagged for a future decision on whether to remove that too.
- **Source:** CC session, Cleanup@autonomOS worker.

## ADR-038: Remove Anthropic API endpoint override; test harness uses env inheritance
- **Date:** 2026-06-13 — **Decided by:** Human (Terry), implemented by Cleanup@autonomOS
- **Context:** A per-session settings field (`anthropicBaseUrl` + `anthropicAuthToken` + `anthropicOverrideEnabled`) let users override the default Anthropic API endpoint with a custom URL paired with an auth token. The override was injected into spawned-session env via `buildBaseEnv`. The only real consumer was the real-claude integration test harness, which uses the override mechanism to redirect `claude` at a mock `/v1/messages` SSE backend (see test-redesign work).
- **Decision:** Remove the user-visible feature (PR #214). The test harness migrates to plain process-environment inheritance: `bootEmbedded` sets `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` on the embedded server's process env, `buildBaseEnv` already spreads `{...process.env}` into spawned sessions, and `claude` reads the env vars natively. Zero production code retained to serve the test framework. `anthropicBaseUrl` / `anthropicAuthToken` / `anthropicOverrideEnabled` settings keys are *actively scrubbed* on read (the auth token is a credential and must not linger on disk after the feature is gone). `customEnvVars` remains as the documented escape hatch for users with proxy needs.
- **Rationale:** (1) Cleaner architecture — zero production code retained for testing beats an env-var-only feature flag. (2) Credential hygiene — an auth token in `settings.json` after the feature is gone is mild leak surface; active scrubbing closes it.
- **Alternatives considered:**
  - Keep an env-var-only settings path (read but no UI) — rejected; still surface area carrying the same code paths internally.
  - MITM proxy or iptables-based redirect for the test mock — rejected; significant complexity to replace something that comes for free with process-env inheritance.
  - Accept test breakage and disable the integration suite — rejected; the harness is load-bearing for desktop-app correctness.
- **Source:** CC session, Cleanup@autonomOS worker. Shipped in PR #214 stacked on PR #213.

## ADR-039: Terminal is the only view; xterm.js is the only renderer
- **Date:** 2026-06-19 — **Decided by:** Human (Terry), implemented by Cleanup@autonomOS
- **Context:** Two alternative-surface features had accrued cost with no real use: (1) "view mode" — a `/api/conversation` route parsing CC session JSONL into a structured web conversation view (`ClaudeCodeParser` + render/parser types in core, `ConversationView`/`DiffView` in dashboard), toggled against the live terminal; the parser had a single consumer. (2) A pluggable terminal-renderer layer letting users switch xterm.js vs a Ghostty (`ghostty-web`) backend via a `terminalRenderer` setting — a second renderer no one selected, dragging in a WASM blob.
- **Decision:** Remove both. Terminal via xterm.js is the only view and only renderer. Delete the conversation route + core parser/render types + dashboard conversation components; collapse the renderer factory so `useTerminal` calls `createXtermBackend` directly. `viewMode` was dashboard-only `localStorage` state (no server migration). `terminalRenderer` IS a `settings.json` key → added to `REMOVED_KEYS` for accept-and-discard (scrubbed on read with a warning, dropped on next persist; non-credential so no active-credential scrub), matching ADR-037/038. Drop 5 now-dead deps (`ghostty-web`, `react-syntax-highlighter` + types, unused `@assistant-ui/react` + `@assistant-ui/react-streamdown` — the latter two were already dead in both root + dashboard manifests).
- **Rationale:** Less surface, lighter bundle ("terminal only" — Terry's intent). OSC8 Ctrl/Cmd+click links preserved via xterm's `linkHandler` (same `hasPrimaryModifier` gate as Ghostty's provider).
- **Note:** The "Inbox Agent" Terry still saw in settings was a STALE embedded dashboard bundle (`packages/server/dist/<plat>/_embedded_dashboard/`, built pre-#213), not live code; a rebuild clears it — verified in this PR's fresh build.
- **Alternatives considered:** Keep view-mode/Ghostty dormant — rejected, carrying cost, no use. Active-scrub `terminalRenderer` — unnecessary, not a credential.
- **Source:** CC session, Cleanup@autonomOS worker. Shipped in PR #220.

## ADR-040: `selectUsageOrg()` heuristic — pick `chat`/`claude_max` capability, not `memberships[0]`
- **Date:** 2026-06-20 — **Decided by:** Human (Terry, pushed back on "why doesn't it actually work?"), implemented by ClaudeUsage@autonomOS
- **Context:** ADR-035 dropped the explicit org field from settings and delegated org resolution to claude.ai's bootstrap API, but did NOT specify the auto-resolve heuristic. The unstated implementation default — `fetchOrgId` taking `memberships[0]` — silently fails for multi-org accounts. Specifically, accounts that have both an Anthropic API/console org AND a Claude.ai chat-tier org typically have the API org at `memberships[0]` and the chat org at `memberships[1]+`. Calling `/usage` with the API org returns 403 "Invalid authorization for organization" — which the scanner then maps to `unauthorized`, the UI surfaces as "session cookie may be expired," and re-entering the (valid) session key never escapes the loop. Terry's account is the exemplar; this affects every autonomOS user who's also an Anthropic API customer (a large fraction of the actual user base by definition).
- **Decision:** Introduce `selectUsageOrg()` that picks the org with capability `chat` or `claude_max`. Single-org accounts fall through to sole-org. The selection is applied at the same point in the bootstrap-resolution flow that `memberships[0]` previously was. Cookie-fingerprinted cache (added in the same PR) prevents the selection from being stale across credential changes.
- **Rationale:** Matches the actual claude.ai web client's selection behavior (chat-tier orgs are what serves usage data; API/console orgs aren't). Addresses the largest mis-classification path discovered post-ADR-035 with one targeted code change.
- **Alternatives considered:**
  - Require the user to pick an org in settings — rejected; reverses ADR-035's UX win for a problem that can be auto-resolved with a stable heuristic.
  - Try each membership in order and pick the first that returns 200 — rejected; multiple 403 attempts is observable latency, log noise, and risks rate-limit interactions.
  - Hardcode known org-name patterns — rejected; brittle, and the API/Claude.ai-Chat distinction is a stable capability, not a name.
- **Note:** Refines (does not reverse) the auto-resolve direction of ADR-035. The `memberships[0]` assumption ADR-035 inherited implicitly was an under-specification in that ADR's text; this ADR records the actual selection rule that should have been part of ADR-035.
- **Source:** CC session, ClaudeUsage@autonomOS worker. Shipped in PR #219.

## ADR-041: Zero-touch Claude Usage via in-memory cookie harvest from spawned agents
- **Date:** 2026-06-20 — **Decided by:** Human (Terry, set the constraints and rejected the weaker options), designed + implemented by ClaudeUsage@autonomOS under TeamLead@autonomOS lead
- **Context:** The Claude Usage plugin required the user to open claude.ai DevTools, copy the `sessionKey` cookie, and paste it into settings. ADR-035 reduced the credential surface (dropped the org field) but didn't eliminate the manual paste. Two "free" alternatives were investigated and rejected: (1) reading `CLAUDE_SESSION_COOKIE` from the server's own environment — Claude Code injects it into processes it spawns, but a normal `make prod` install (PM2/launchd from a plain shell) is NOT a Claude Code child, so its env lacks the cookie; (2) reading Claude Code's on-disk OAuth token (`~/.claude/.credentials.json` `claudeAiOauth`) — empirically stale, because CC refreshes the token in-memory and does not write it back to disk (observed token ~23 days expired). Neither works for the install method real users run.
- **Decision:** Harvest the session cookie from the agents the server spawns. Claude Code injects `CLAUDE_SESSION_COOKIE` into every process it spawns, including the hooks autonomOS attaches to each session. A SessionStart hook relays the cookie (shell-expanded straight into curl's stdin — never in process argv) to a dedicated server endpoint `POST /api/plugins/claude-usage/session`, which holds it IN MEMORY ONLY (never written to disk) for the usage plugin. This works on any install — including a server with no Claude Code ancestry — once an agent has run. Credential precedence: manual settings key > `CLAUDE_SESSION_KEY` env > harvested cookie > the server's own `CLAUDE_SESSION_COOKIE`. An `autoDetectClaudeSession` setting (default on) opts out and drops the in-memory cookie immediately. The dashboard shows "Auto-detected from Claude Code" when the credential is inherited.
- **Security:** The harvest endpoint is unauthenticated only on a loopback bind (`isLoopbackBind()`), mirroring the existing `/api/hooks` localhost-trust model. On a non-loopback bind (remote `make deploy`) it falls through to the standard auth middleware, because an open POST that sets the credential the server authenticates to claude.ai with would otherwise be a credential-injection vector. Payloads are validated against a strict session-key shape (`^sk-ant-sid[A-Za-z0-9._-]+$`), rejecting OAuth/API tokens and header-injection characters. The cookie is never logged (only a non-reversible SHA-256 fingerprint is).
- **Privacy posture:** In-memory only — strictly more private than the manual-paste path, which persisted the key to `settings.json` in plaintext. Never logged. Re-harvested on each agent spawn (always fresh; no stale-token problem) and evicted on restart, which matches credential-revocation semantics. Opt-out clears it immediately, before the settings disk write so it isn't gated on persistence success.
- **Rationale:** Exploits existing Claude Code behavior (env injection into children) rather than depending on a new CC feature — robust to CC's roadmap. In-memory eviction is a feature, not a limitation: it bounds credential lifetime to the server process and self-refreshes. Loopback-gated exemption preserves zero-touch for the common local install without weakening remote deployments.
- **Alternatives considered:**
  - Read the server's own `CLAUDE_SESSION_COOKIE` env — rejected; absent on `make prod` servers not spawned by Claude Code (works only for dev/CC-spawned servers; retained as the lowest-priority fallback tier, harmless).
  - Read Claude Code's on-disk OAuth token / refresh it server-side — rejected; the on-disk token is stale (CC doesn't write refreshes back) and a server-side refresh would rotate CC's own login token (`invalid_grant`, breaks the user's CC).
  - The official-ish OAuth usage API (`api.anthropic.com/api/oauth/usage`) — rejected as primary; needs the keychain OAuth token (token-freshness-fragile, macOS keychain) for marginal ToS benefit.
  - Persistent disk-stored harvested cookie — rejected; on-disk credential leak surface + provenance confusion, with no benefit over re-harvesting.
  - Statusline-based relay — rejected; the statusline is user-toggleable, so it's not a reliable carrier (hooks are injected unconditionally).
- **Guard against a security regression:** the auth-exempt-on-loopback design surfaced a HIGH-severity finding in /polish — the endpoint was originally unconditionally auth-exempt and would have been a credential-injection vector on non-loopback binds. Fixed pre-ship; locked by a unit test asserting `isLoopbackBind` rejects `0.0.0.0`/non-loopback hosts.
- **Note:** Refines the auto-resolve direction of ADR-035 (less manual input) and composes with ADR-040 (`selectUsageOrg` chat-org selection); does not reverse either.
- **Source:** CC session, ClaudeUsage@autonomOS worker, keyless-usage ultracode research workflow + Terry's direct constraints on launch-context and privacy. Shipped in PR #221.

## ADR-042: Insecure-context clipboard fallback for OSC 52 auto-copy
- **Date:** 2026-06-19 — **Decided by:** Human (Terry), implemented by RemoteCopy@autonomOS
- **Context:** Claude Code's auto-copy-on-select via OSC 52 worked on localhost-served autonomOS but silently failed on remote-served deployments. Root cause: `navigator.clipboard` is `undefined` in an insecure context (plain HTTP, non-localhost origin), and the OSC 52 handler at `packages/dashboard/src/terminal/xterm-backend.ts` did an unconditional `.writeText`, which threw synchronously. The throw was caught by an outer handler designed for OSC 52 decode errors and mis-logged as "OSC 52 decode failed" — silent. The byte pipeline (CC → PTY → WS → xterm → handler) was intact in both modes; local "worked" purely because browsers treat localhost/127.0.0.1 as secure-context exceptions. autonomOS's remote deployment shape (`make deploy` → `make prod` → PM2 on `:3100` plain HTTP, no TLS) is exactly the insecure-context case.
- **Decision:** Capability-detect the clipboard at write time. Secure context (localhost or HTTPS) → use `navigator.clipboard.writeText` (the existing happy path, unchanged). Insecure context (plain HTTP non-localhost) → fall back to transient-textarea + `document.execCommand('copy')`. The same dashboard build self-selects per origin → local + remote both work from one artifact. A `console.warn` breadcrumb fires only when both paths fail.
- **Rationale:** `execCommand('copy')` is the only clipboard write available in non-secure contexts; it requires transient user activation, but OSC 52 fires within milliseconds of the user's mouse-up select, which is well inside the ~5-second activation window. HTTPS deployment remains the recommended/cleaner posture (also fixes a parallel insecure-context bug in `PreviewPane.tsx:128`'s copy-link), but the feature should not be gated on the operator running TLS.
- **Alternatives considered:**
  - Require HTTPS deployment — rejected as the only path; should be recommended but not blocking, since the per-user friction of getting TLS in front of a `make prod` install is real.
  - Server-side `pbcopy`/`xclip` — rejected; writes to the wrong machine's clipboard for true remote (server's clipboard, not the viewing user's).
  - `@xterm/addon-clipboard` — rejected; same `navigator.clipboard`-only implementation, fails identically.
  - Chrome's `--unsafely-treat-insecure-origin-as-secure` flag — rejected; per-user, brittle, requires browser configuration.
- **Known caveat:** Server-pushed OSC 52 has no click in its call stack; if the user-activation window has expired (e.g., the user hasn't interacted recently), both clipboard paths fail and the breadcrumb logs without a copy occurring. A future one-click Copy affordance is the planned cover for that tail case.
- **Note:** Same root cause (insecure-context, `navigator.clipboard` undefined) also broke `PreviewPane.tsx`'s copy-link; the fix pattern from this ADR is the template for resolving that. Recommends HTTPS as the proper app-wide fix.
- **Source:** CC session, RemoteCopy@autonomOS worker, 7-agent ultracode research workflow. Shipped in PR #222.

## ADR-043: Dashboard distribution contract — embedded bundle is binary-only; hosted server serves `dashboard/dist`
- **Date:** 2026-06-20 — **Decided by:** Human (Terry), implemented by RemoteCopy@autonomOS
- **Context:** The server prefers `packages/server/src/_embedded_dashboard/` over `packages/dashboard/dist` (resolution order in `run.ts:179-180`). `_embedded_dashboard` is produced only by the binary build chain (`build:embed-dashboard`, for `bun --compile`). But `make deploy` rsynced a stale local `_embedded_dashboard` to the remote (the rsync excludes were `node_modules/.env/dist/.git` — `src/_embedded_dashboard` is under `src/`, so it shipped). And `make prod` rebuilt `dashboard/dist` but NOT the embedded copy — so the hosted (tsx) server served a stale embedded bundle shadowing the fresh dist. Caused a real regression on forge (served a months-old UI), hand-patched three times before this PR.
- **Decision:** Treat `_embedded_dashboard` as a **binary-distribution artifact only**. The hosted server serves `packages/dashboard/dist`. Enforced by: (a) `make prod` `rm -rf _embedded_dashboard` before the vite build; (b) `make deploy` rsync `--exclude _embedded_dashboard`. Plus an observability guardrail: the server logs the served bundle id + `index.html` mtime at startup and exposes them on `/api/host` as `{dashboard: {build, builtAt}}`; the dashboard `console.warn`s when its loaded bundle id != the server's served bundle id.
- **Rationale:** Matches the resolution-order comment's original intent (embedded = binary build time; dist = tsx fallback) and Terry's mental model. The guardrail converts a silent, recurring, hard-to-diagnose failure into a visible one — the next stale-bundle event surfaces immediately in server logs or the dashboard console rather than after a regression bites a user.
- **Alternatives considered:**
  - Have `make prod` *regenerate* `_embedded_dashboard` from `dist` each deploy — rejected; keeps an unnecessary duplicate copy on the hosted box, redundant with `dist`, and the resolution-order preference makes the duplicate dangerous if it drifts.
  - Rsync `--exclude` only, no `rm` — rejected; `--exclude` is prospective (doesn't add new staleness) but does NOT clean up an existing stale remote `_embedded_dashboard` left from a prior deploy. The `rm` in `make prod` is load-bearing because it self-heals the remote on the next deploy.
- **Long-term direction (earmarked, not in this PR):** Converge the hosted deploy onto the install.sh / built-bundle distribution path established by #170 (CLI + service-manager work) and retire the rsync-source-and-build-on-target pattern. One versioned artifact for both desktop-embedded and hosted distribution, matching the release train. Discussed with Terry and explicitly deferred per the "personal tool first" project tenet — the right strategic direction, not the right immediate work.
- **Note:** Two operational issues surfaced during deployment of this fix to forge: (1) a 27-day-old install-CLI server orphan was holding `:3100`, causing pm2 EADDRINUSE crash-loops — cleaned up in the same deploy. (2) The `wt-sync`-deletes-worktree-after-merge → `cd <gone> && make deploy` silently-falls-through-to-main-repo hazard worked by luck this time but remains a fragile interaction. Worth tracking; not addressed here.
- **Source:** CC session, RemoteCopy@autonomOS worker, surfaced during forge deployment of PRs #222 and #224. Shipped in PR #227.

## ADR-044: Consolidated release notes merge all per-package CHANGELOGs (one line per PR)
- **Date:** 2026-06-22 — **Decided by:** Human (Terry) via TeamLead@autonomOS, implemented by SyncChangelogFix@autonomOS
- **Context:** `changeset version` writes one CHANGELOG.md per package, and `@changesets/changelog-github` files each changeset's entry ONLY into the CHANGELOG of the package(s) its frontmatter names. The `fixed` group (`.changeset/config.json`) locks version NUMBERS in lockstep but does NOT replicate entries across packages. `scripts/sync-changelog.ts` promoted a single representative package (`packages/app/CHANGELOG.md`) into the root CHANGELOG / GitHub Release body, so every server-/dashboard-/core-/cli-only changeset was silently dropped. v0.3.0's release body initially showed 1 of ~21 changes; root `## [0.2.0]` was entirely empty for the same reason.
- **Decision:** The consolidator merges EVERY `packages/*/CHANGELOG.md`, deduplicates by PR number (highest severity wins on collision), and renders ONE concise line per PR — the title taken from the squash-merge commit subject (`git log -1 --format=%s`, trailing ` (#NNN)` stripped). Per-package CHANGELOGs stay verbose for posterity; only the root CHANGELOG (and thus the Release body) is condensed. `scripts/release-notes.ts` is unchanged — it faithfully extracts whatever section this writes.
- **Rationale:** Correctness (no package's changes can be invisible) + brevity (Terry's one-line-per-PR preference, established when v0.3.0's verbose body was rejected). This mechanical output is the **floor of correctness**; a friendly/themed release body is a separate **ceiling layer** (future work) that rewrites on top — it does not change this contract.
- **Invariant for future readers:** If you add a 6th package to the `fixed` group, the consolidator already globs `packages/*/CHANGELOG.md`, so it's picked up automatically — but any change to per-package CHANGELOG structure (heading format, swapping `@changesets/changelog-github` for another renderer) must keep `parseEntries`' signature-anchored detection valid, or entries silently vanish. The script self-guards: it hard-fails on an empty section when real changesets were consumed, and warns when parsed-entry count < non-empty-consumed-changeset count (partial-drop detection).
- **Alternatives considered:**
  - Read a single representative package — the bug being fixed; only correct if every changeset always lists that package.
  - Generate from `git log` between tags — loses changeset-curated severity (minor vs patch).
  - Read raw `.changeset/*.md` pre-consumption — loses `@changesets/changelog-github`'s PR/author resolution and needs the pre-`changeset version` timing.
- **Source:** autonomOS CC session, SyncChangelogFix@autonomOS worker; flagged by nox-0x on PRs #205/#211. Shipped in PR #244 (commit `49e35f8`).

## ADR-045: Per-provider permission modes replace the `autonomousMode` boolean
- **Date:** 2026-06-26 — **Decided by:** Human (Terry) via TeamLead@autonomOS, implemented by PermissionModes@autonomOS
- **Context:** Every spawn carried a single `autonomousMode: boolean` that mapped to one all-or-nothing flag per provider (Claude `--dangerously-skip-permissions`, Gemini `--approval-mode yolo`, Codex `--dangerously-bypass-approvals-and-sandbox` / `approval_policy=never`). It defaulted to `true` everywhere. This couldn't express the granularity each CLI actually supports — auto-accept-edits, read-only plan mode, ask-on-failure — so an agent was either fully supervised or fully unleashed. The boolean lived in ~50 places (core types, persisted Agent records, templates, MCP `create_agent`/`create_template`, REST, channel-server relay, dashboard store + 3 UI surfaces).
- **Decision:** Introduce a provider-agnostic `PermissionMode = "default" | "auto" | "plan" | "bypass"` (core `types/permissions.ts`) stored at every layer; each provider's `buildArgs` maps it to native flags. Claude → `--permission-mode default|acceptEdits|plan`, bypass keeps `--dangerously-skip-permissions` (exact prior behavior, also auto-accepts the trust prompt). Gemini → `--approval-mode default|auto_edit|plan|yolo`. Codex → `approval_policy=on-request|on-failure|never`, with the sandbox **always** `danger-full-access`. The field is renamed (`autonomousMode` → `permissionMode`) so the type checker flags every consumer (semantic-remap → rename). Settings holds a global default; Create Agent overrides per spawn (B2). A shared `PermissionModeSelect` component shows a clickable "?" current-selection explainer sourced from core's `PERMISSION_MODE_INFO` (single source of truth, no UI/flag drift).
- **Rationale (the key judgment):** Codex's "two axes" (approval + sandbox) is already collapsed to one inside autonomOS — the sandbox is infra-locked to `danger-full-access` because autonomOS is the trust boundary and Codex's OS sandbox (bubblewrap/Seatbelt) breaks in the daemon topology (ADR-038 era). So flattening to a common enum loses no signal autonomOS hadn't already discarded by design. Claude and Gemini are natively near-identical 4-value enums, so a common vocabulary fits them perfectly. And the provider-agnostic layers (global default, templates, the MCP arg) *cannot* store native per-provider values without a provider selector — a common vocabulary is forced by the architecture. This made A2 (common enum) the clear choice over A1 (per-provider native fields) and A3 (hybrid).
- **Codex `plan` gap:** Codex has no read-only plan mode. Rather than unlock the sandbox to `read-only` (which reintroduces the bubblewrap dependency we removed), `plan` is disabled for Codex in the UI (`PERMISSION_MODE_INFO.plan.unsupportedBy = ["codex"]`) and clamps to the default (`approval_policy=on-request`) with a one-time warning at the spawn boundary.
- **Migration (accept-and-discard, per ADR-035/037/038):** On read, legacy `autonomousMode: true → bypass`, `false → default`; the old field is scrubbed and a warning names it. Applied at the per-agent store (`agents/store.ts` load-time backfill, mirroring the existing `provider` backfill), the one-shot `sessions.json` migration (`agents/migrate.ts`), default templates, and dashboard `localStorage` rehydration. **Reversible decision flagged for review:** an *unspecified* `permissionMode` resolves to `DEFAULT_PERMISSION_MODE = "bypass"`, matching the old pervasive `?? true`, to avoid silently making autonomous spawns start prompting. Flipping the default to `"default"` (ask-first) is a one-line change if desired.
- **Out of scope:** the scheduler's separate `autonomous` boolean (headless isolated runs, different semantics) is untouched — a candidate for a future unification.
- **Alternatives considered:** A1 (faithful per-provider native fields) — most accurate but needs a 3-key provider map at every provider-agnostic layer (templates, settings, MCP arg) and triples the UI surface. A3 (common enum + per-provider advanced override) — best for expert Codex `approval_policy` tuning, but more code than the personal-tool-first scope warrants; it remains a clean *additive* follow-up since A2 doesn't preclude it. Keeping the boolean and adding a second boolean — strictly worse than an enum.
- **Source:** autonomOS CC session, PermissionModes@autonomOS worker; propose-pause approved by Terry. Shipped in PR #257.
- **Update (2026-06-26, PR #261):** The reversible default was flipped — `DEFAULT_PERMISSION_MODE` is now `"default"` (ask-first / fail-closed), not `"bypass"`. The bypass default proved fragile: it emits `--dangerously-skip-permissions`, which the real claude binary refuses in CI/under root (it broke 3 RUN_INTEGRATION-gated suites on #257, invisible to local `make check`), and it silently granted full autonomy to any spawn that forgot a mode. Terry decided a safe default outweighs mirroring the old `?? true`. Migration of EXISTING records is unchanged (`autonomousMode: true` still → `bypass`), so configured installs keep their behavior; only fresh/unspecified spawns get the safe default. Callers wanting autonomy set `bypass` explicitly. Also: Claude `default` mode emits NO flag (`--permission-mode default` is redundant with claude's built-in default and perturbs interactive-TUI startup timing).

## ADR-046: Claude Usage tracks account switches by scanning the user's live Claude sessions (not env inheritance)
- **Date:** 2026-06-26 — **Decided by:** Human (Terry) via TeamLead@autonomOS, implemented by UsageAccountSwitch@autonomOS
- **Context:** The Claude Usage plugin failed to follow a Claude Code account switch: after Terry logged into a different account and restarted his agent sessions, usage stayed pinned to the old account. ADR-041's zero-touch design assumed Claude Code re-derives `CLAUDE_SESSION_COOKIE` per session and that relaying it from spawned agents' SessionStart hooks keeps it fresh. **Empirical testing refuted both assumptions** (claude v2.1.193): `CLAUDE_SESSION_COOKIE` is *propagate-only* — Claude Code inherits it from its parent process env and passes it to children/hooks, but never re-derives it from the logged-in account (strip the var from a fresh top-level `claude`'s env and no hook on any event ever sees it, yet the session still authenticates — via OAuth). Consequence: the cookie a long-running autonomOS server holds is **frozen at launch** (PM2/launchd captures the env of whatever shell started the server), and every agent the server spawns inherits that same frozen value. Restarting agent *sessions* can never switch accounts; only restarting the *server* from a new-account shell would. ADR-041's claim that agent-harvest "works on any install once an agent has run" is therefore false — harvesting only ever re-broadcast the server's own (possibly absent) cookie.
- **Decision:** Discover the active session key by **scanning the user's own running `claude` processes** and adopting the `CLAUDE_SESSION_COOKIE` of the most-recently-started **external** session. The server's own process tree is excluded — by **process ancestry** (the scan runs inside the server, so anything descending from `process.pid` is server-spawned: agents, scheduler `isolated` runs, the server itself) **and** by `AUTONOMOS_*` env markers (a backstop, since ancestry breaks if an intermediate parent dies and the process reparents to init, while the inherited env marker survives). The freshly-logged-in account's cookie lives only in the user's interactive sessions, which are separate process trees. The scan runs lazily on the usage-fetch path (throttled ~5s, de-duplicated), reads process env via `ps xeww` on macOS / `/proc/<pid>/environ` on Linux (current user only — where the cookie already lives), validates the strict `sk-ant-sid…` shape, never logs the value, and on change replaces the in-memory key + invalidates the usage cache (the cookie→org→usage invalidation chain already existed). A persistent scan failure is surfaced via a throttled diagnostic so it never silently pins usage to the stale fallback. The SessionStart cookie relay is **no longer attached to spawned agents** (it only ever fed the frozen value and would clobber the scan); the relay command + harvest endpoint remain for an optional user-level push hook. Manual-paste (tier-1) and the server's own env (tier-4) remain unchanged as override/fallback.
- **Rationale:** It reads the credential from where the *current* account's cookie actually is, so it follows a switch with no restart, no OAuth, and no manual paste — and it explicitly does **not** depend on the server itself having a cookie (a `make prod`/launchd server with no Claude Code ancestry has none; the scan finds the user's interactive sessions instead). No new credential exposure: the cookie is already in the user's own process env; the scan only reads it.
- **Constraints / limits:** Requires a live external `claude` session under the new account at scan time (a short-lived login can be caught by the optional user-level push hook). Local-host only — for a remote `make deploy` server the user's interactive sessions aren't co-located, so manual-paste remains the path there. OAuth was explicitly rejected by Terry as the credential source.
- **Alternatives considered:**
  - Strip `CLAUDE_SESSION_COOKIE` in `buildBaseEnv` so spawned agents re-derive it — **refuted by testing**: Claude Code never re-derives, so this would yield no cookie at all (kills harvesting).
  - OAuth refresh-token → fresh access token → usage API — rejected by Terry (no OAuth); also risks rotating the refresh token Claude Code relies on.
  - Read a persisted on-disk session key — none exists; `~/.claude/.credentials.json` and the keychain hold only OAuth (`sk-ant-oat…`), no `sk-ant-sid…`.
  - Decrypt the Claude *desktop app*'s cookie store — a separate login from Claude Code; not reliably the same account.
- **Supersedes:** ADR-041's premise that env-relayed agent harvest keeps the cookie fresh / works on any install. Composes with ADR-040 (`selectUsageOrg`) and ADR-035 (session-key-only credential).
- **Source:** autonomOS CC session, UsageAccountSwitch@autonomOS worker; investigation directed by Terry (empirical propagate-only finding via controlled `claude -p`/PTY spawns + live process-tree trace).

## ADR-047: Rebuild the tabs + split-pane layout on dockview, removing the binary-tree model, the detached overlay, and the `groups` system
- **Date:** 2026-06-27 — **Decided by:** Human (Terry), direction-setting across an investigation + mockup review; implemented by LayoutRefactor@autonomOS.
- **Context:** Terry's standing complaint that the terminal tabs + split-pane system has "always been broken." Phase-1 investigation (`packages/dashboard/src/layout/`) found the framing had drifted from reality: tabs (#103), drag-to-edge splitting, tab-drag-between-panes, and the detached-terminal overlay were all already built, and the two memory-tracked bugs (ghost tabs, broken close button) had **already shipped fixes** in #123 / #167 (see [[project_stale_layout_tabs]]). The genuine sources of "broken" were architectural, not missing features: **(1)** the **detached-overlay geometry sync** — xterm.js instances are mounted once at the app root (`SessionMountLayer`) and hand-positioned over empty slot rects via `getBoundingClientRect` + `ResizeObserver` + `rAF` + a manual `setTick`, with no single source of truth, so terminals visually desync from their slots on resize-during-load / sidebar toggle / fast drag; **(2)** the **`groups` system** (`store.ts` PaneGroup, `switchPane`) — a hidden "workspace" layer that snapshots an entire split arrangement and silently swaps the whole visible layout when the user clicks a sidebar agent belonging to another group, with near-zero affordance; **(3)** polish gaps vs. modern terminals (no pane zoom, equalize, command palette, keyboard tab-switching, dim-inactive). A library survey ranked dockview-class docking libraries on performance + popularity + maintenance, gated by a hard constraint: because we self-mount xterm.js, any library that **remounts panel content on drag/tab-switch is near-disqualifying** (it wipes scrollback). dockview is the only option that solves this with a first-class, documented keep-alive API.
- **Decision:** Replace the hand-rolled layout engine with **dockview** (`dockview-react@^7`), configured with **`defaultRenderer: 'always'`** so every panel's DOM (and thus its xterm.js instance) stays mounted-but-hidden across tab-switches and re-docks. **(a) State ownership inverts for layout only:** dockview's internal model becomes the source of truth for layout *topology* (panel placement, splits, tab order); Zustand keeps owning *content* state (`sessions`, `agentStatuses`, `previewPanes`) and persists dockview's `toJSON()` serialization blob in the existing `persist` partialize. Existing panel components (`SessionPane`, `PreviewPane`, `HierarchyPanel`, `TemplatesPanel`, `SchedulesPanel`, `CreateAgentPanel`) survive unchanged as dockview panel content. **(b) The `groups` system is removed entirely** — one canonical layout, no workspace snapshotting. **(c) Tab placement is Option A** (Terry's pick from rendered A/B/C/D mockups): dockview-native per-group tab bars inside the layout; the existing full-width `Header` stays a control bar (command palette / New agent / connection), never a global tab bar. **(d) Net deletion:** `layoutTree.ts` (+ its 723-line test), `SplitLayout.tsx`, `PaneSlot.tsx`, `SessionMountLayer.tsx`, `LayoutContext.tsx`, `DragContext.tsx`, `DropZoneOverlay.tsx`, `TabBar.tsx`, and the `groups`/binary-tree slices of the store (~1,500 LOC of fragile custom code retired). **(e) Migration is incremental behind a `layoutEngine: 'legacy' | 'dockview'` store flag** (default `legacy`), so each PR ships with zero default behavior change and is independently revertible: PR-1 dep + flagged shell + panel host + custom status tab; PR-2 content + sidebar→dockview wiring; PR-3 splitting + `Ctrl+D`/`Ctrl+Shift+D`/`Ctrl+W` keybinds + persistence; PR-4 command palette + zoom/maximize + floating panels; PR-5 delete legacy + flip default. `react-resizable-panels` is removed once the legacy path is deleted.
- **Phasing:** PR-1 = dependency + flagged shell + panel host + custom status tab (**no deletions**); PR-2 = content wiring + sidebar→dockview (**no deletions**); PR-3 = splitting + `Ctrl+D`/`Ctrl+Shift+D`/`Ctrl+W` keybinds + persistence (`toJSON`), including the drag-survives-scrollback spike; PR-4 = command palette + zoom/maximize + floating panels; **PR-5 = delete legacy** — the ~1,500 LOC (binary tree + overlay + `groups`) come out atomically with the flag flipping to `dockview` by default, and `react-resizable-panels` is dropped here. So "groups removed" / "overlay deleted" land on **PR-5**, not PR-1.
- **Rationale:** `defaultRenderer:'always'` is the load-bearing property, and it's what ties the whole combination together. It lets xterm.js survive any drag/resize/reorder without a remount — which eliminates the *reason the detached overlay existed at all*. Once self-mounting is unnecessary, the binary-tree model and the overlay's geometry-sync machinery (`getBoundingClientRect`/`ResizeObserver`/`rAF`/`setTick`) become dead code rather than something to port, so the rewrite *deletes* code instead of adding a parallel engine. State ownership inverts for layout-only for the same root cause: dockview imperatively owns topology, and the prior desync class came precisely from a reactive Zustand tree trying to mirror imperative geometry — letting dockview be the single source of truth for *where panels are* removes that fight, while Zustand keeps *what's in them*. `groups` is removed in the same pass because its complexity wasn't earning its keep — a near-zero-affordance workspace-swap with no observable user value, and nothing in the new model needs it. Library choice is personal-tool-first: dockview is React-19-native (clean install against React 19.2.6), the most actively maintained option (v7 shipped 4 days before this ADR), MIT + zero-deps (forkable), and ships native popout + `toJSON/fromJSON` — chosen over richer-but-heavier or stale alternatives. The flag makes a large rewrite safe to land in small, reversible increments.
- **Constraints / limits:** dockview is effectively a single-maintainer project (MIT, zero runtime deps → forkable if abandoned). Two behaviors to verify mid-migration (PR-3): drag-a-terminal-into-a-new-split must preserve the xterm instance (architecturally expected — dockview relocates DOM rather than recreating — but not documented verbatim), and `fromJSON()` layout restore recreates panels (dockview #718), meaning a wholesale layout restore on reload yields fresh terminals — low-impact for us since a reload re-attaches the server PTY buffer anyway, so keep-alive only needs to hold *within* a session. New dependency weight ~80 KB gz.
- **Alternatives considered:**
  - **Harden the existing architecture in place** (fix overlay sync, make `groups` visible) — rejected by Terry in favor of rip-and-replace; the overlay's eventual-consistency design has no clean single-source-of-truth fix without a rewrite.
  - **Keep `react-resizable-panels` and build tabs/DnD on top** — that work is already done; it doesn't address the overlay fragility or the `groups` confusion.
  - **flexlayout-react** (runner-up) — keep-alive by default, lighter (33 KB), company-backed (lower bus-factor); rejected only because dockview's explicit per-panel keep-alive API, native popout, and higher activity won, but it remains the documented fallback if dockview is abandoned.
  - **rc-dock / react-mosaic / golden-layout / @lumino/widgets** — rejected: rc-dock is a stale alpha; react-mosaic and golden-layout **remount content on drag** (disqualifying for xterm); lumino is imperative non-React.
  - **Tab-placement B (header tabs) / C (adaptive) / D (full-height-left, no header bar)** — rendered as HTML mockups; Terry chose A for unambiguous splits ("which tabs belong to which pane") with the header reserved as a control bar.
- **Source:** autonomOS CC session, LayoutRefactor@autonomOS; investigation + ranked library survey + interactive HTML mockups (A/B/C/D × single/split, real midnight theme), direction set by Terry across the session; ADR routing endorsed by TeamLead@autonomOS (bundle-with-PR-1, per the #257 precedent).

- **Update (2026-06-28, Terry, PR #263):** The default flips to `dockview` **now**, ahead of the original PR-5 schedule above. The combined PR landed the dockview engine plus the workspace/persistence layer, two terminal-bug fixes (sidebar-highlight flicker, idle self-shrink), and chrome polish — Terry reviewed it live and chose to ship it on by default ("this is a really good feature I'd like to ship by default, people should use this"). The `layoutEngine` flag is retained with `legacy` reachable as a fallback; the legacy code (binary tree + overlay + `groups`) is **not** deleted yet — that atomic removal, plus dropping `react-resizable-panels`, remains a later phase. So the only deviation from the phasing above is *when* the default flips, not the eventual end state. A Settings UI toggle to switch engines without editing persisted state is a tracked fast-follow.

## ADR-048: Claude Usage via read-only OAuth token + manual session-key override; cookie-scan/harvest removed
- **Date:** 2026-06-28 — **Decided by:** Human (Terry), reversing his prior "no OAuth" stance after the cookie approach proved unobtainable on a clean install; implemented by UsageOAuth@autonomOS.
- **Context:** The claude.ai `sessionKey` cookie — the credential the usage plugin has chased through ADR-040/041/046 — is **not derivable on a clean Claude Code install**. Empirical finding (claude v2.1.x, confirmed across ADR-046's investigation): `CLAUDE_SESSION_COOKIE` is *propagate-only* (Claude Code inherits and forwards it but never re-derives it from the logged-in account), and a freshly-logged-in account that has only ever authenticated via OAuth has **no `sk-ant-sid…` cookie anywhere** to scan, harvest, or read from disk — `~/.claude/.credentials.json` and the macOS keychain hold only the OAuth blob. ADR-046's process-scan therefore finds nothing on the common case (OAuth-only login, no stray cookie-bearing session), leaving usage permanently in `needsSetup` unless the user manually pastes a cookie. Meanwhile Anthropic exposes `GET https://api.anthropic.com/api/oauth/usage` (auth: `Bearer <accessToken>` + `anthropic-beta: oauth-2025-04-20` + `User-Agent: claude-code/<ver>`), which returns the **full** per-window + per-model + extra-credits payload (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `extra_usage`) — a superset of what the statusline subset offers and equivalent to the claude.ai `/usage` data. The OAuth access token Claude Code already manages locally is readable read-only (env `CLAUDE_CODE_OAUTH_TOKEN`; macOS keychain `Claude Code-credentials` **keyed by `-a $USER`** — the account-less lookup returns a STALE legacy entry, the account-keyed one is FRESH; or `${CLAUDE_CONFIG_DIR or ~/.claude}/.credentials.json` on Linux/Windows), with an ~8h TTL stamped in `expiresAt`.
- **Decision:** Make **read-only OAuth the zero-touch default** credential for the usage plugin, with **manual session-key paste as an explicit override**, and **remove the cookie-scan + harvest machinery** (ADR-046/041). Resolution precedence in `getRateLimits`: (1) dev/QA `usageOverride`; (2) a manual claude.ai key (settings paste or `CLAUDE_SESSION_KEY`) → the existing bootstrap→`/usage` cookie flow, `credentialSource:"settings"|"env"`, UNCHANGED; (3) else, if auto-detect is on, the OAuth flow via the new `oauthUsage.ts` → `credentialSource:"oauth"`. The OAuth path reads the token (priority env→keychain→file), **never refreshes it** (refreshing rotates the token and would break Claude Code's own login), maps `expiresAt <= now` → a paused `errorKind:"stale_token"` result (UI: "token expired — run a session or paste a key"), `401` → `unauthorized`, `429` → `rate_limited` (cached for 5min to back off — the endpoint is shared with Claude Code), network/parse → `unavailable`, and no-token → `needsSetup`. Account identity for display is **email · plan**: email from `~/.claude.json` (HOME root, sibling of the `.claude/` dir), plan/`subscriptionType` from the OAuth token blob — both best-effort; the org UUID is deliberately not displayed. Cache TTL bumped 60s→**180s** (the endpoint is shared with Claude Code itself; stay clear of 429), still fingerprinted by credential (access token for OAuth, session key for manual) so an account switch misses cache. **Removed:** `cookieScanner.ts`, `sessionStore.ts`, the `POST /session` harvest endpoint, `COOKIE_RELAY_CMD`, the `harvested`/`auto` `CredentialSource` tiers, and both cookie/harvest test files. The `autoDetectClaudeSession` setting is renamed `autoDetectClaudeAccount` (old key read as a back-compat fallback).
- **Rationale:** OAuth is where the credential *actually lives* on a clean install, so it works zero-touch for the common (OAuth-only) login that the cookie approaches could never serve. The full per-model+credits payload means no feature regression vs. the cookie `/usage` data (and strictly more than the statusline subset). Read-only/never-refresh is the key safety property — it consumes the token Claude Code maintains without ever rotating it, so it cannot break the user's login. The account-keyed keychain lookup (`-a $USER`) is mandatory because the default lookup silently returns a stale token. Manual paste is retained for remote `make deploy` servers (where the user's local token isn't co-located) and as a deliberate override.
- **Constraints / limits:** OAuth path is local-host (the token must be on the same machine as the server); remote deployments still use manual paste. An expired token (>8h since last Claude Code activity) surfaces as `stale_token` rather than auto-refreshing — the user runs any Claude Code session (which refreshes it) or pastes a key. The token TTL means a fully-idle machine eventually shows `stale_token` until next CC use.
- **Alternatives considered:**
  - **Cookie scan / agent harvest (ADR-046/041)** — rejected/removed: the `sk-ant-sid…` cookie doesn't exist to scan on a clean OAuth-only install (propagate-only env, no on-disk cookie), so it dead-ends in `needsSetup` for the common case.
  - **Statusline usage subset** — insufficient: it lacks the per-model + extra-credits breakdown the panel renders.
  - **OAuth refresh (refresh-token → new access token)** — rejected: refreshing rotates the token Claude Code depends on, breaking its login; read-only consumption avoids this entirely.
- **Supersedes:** ADR-046 (live-session cookie scan) and the cookie lineage of ADR-041/040 as the *primary* credential path. ADR-040's `selectUsageOrg` + ADR-035's session-key-only cookie flow remain in force for the manual-override path.
- **Source:** autonomOS CC session, UsageOAuth@autonomOS worker; OAuth endpoint + token-source facts verified empirically on Terry's machine, fully-specified change approved by Terry.

## ADR-049: Provider-parity resume fallback — never let a missing/un-resumable session drop a Claude Code agent on restart
- **Date:** 2026-06-28 — **Decided by:** Human (Terry), from a direct bug report; investigated + implemented by DevRestartPersistence@autonomOS.
- **Context:** On a `make dev` restart, Codex agents reliably persisted into the dashboard but Claude Code agents *disappeared* — a provider asymmetry. Empirically reproduced in an isolated env (per-file `agents/` store, alt port): both providers' records survive shutdown as `status:"running"`, and `resumeActiveAgents()` (runtime.ts) respawns both. The asymmetry is in the **resume command construction**. Claude Code's `buildArgs` emits `claude --resume <providerSessionId>` *unconditionally* (claude-code.ts), but **Claude Code writes its session JSONL lazily — on the first turn, not at session creation** (verified: the file at `~/.claude/projects/<cwd-dir>/<id>.jsonl` appears only after a turn completes). So any agent that hadn't conversed before the restart (an idle "spawn now, chat later" agent, or one whose starting prompt was still in flight) has **no `--resume` target**; `claude --resume` exits code 1 within ~1s, the PTY `onExit` marks it `exited/crashed`, and `buildAgentTree` filters non-`running` agents out of the sidebar/org chart — so it vanishes. Codex never hit this: a fresh agent has no `providerThreadId`, so `codex.ts` takes the `--remote`-only path (a NEW thread, always spawns), and even when a Codex *resume* fails, runtime.ts already had a self-heal that clears the dead thread id and respawns fresh. Claude Code had **neither** guard. (The earlier hypothesis that "Codex's app-server daemon survives the restart and is rediscovered" was tested and **falsified** — the daemon is a server child, disposed cleanly on shutdown; Codex survives purely because its resume path degrades gracefully.)
- **Decision:** Give both providers one shared resume-recovery contract, in two layers:
  - **(B) Pre-flight existence check.** New optional provider hook `hasResumableSession?(options): boolean` (core `AgentProvider`). The runtime calls it on the resume path *before* building args; when it returns `false`, it clears `resumeSessionId` so the provider spawns a **FRESH session reusing the SAME `providerSessionId`** (`--session-id <id>` instead of `--resume <id>`) — lossless (a never-conversed agent has no history) and id-stable (no record churn, external `agent:<id>` refs intact). Claude Code implements the hook via `existsSync` on the exact JSONL path the SDK uses (`projectsDir()` + `cwdToDirName()` from titleCache). Codex deliberately omits the hook — its internal thread-id check already handles the equivalent — so providers without the hook keep the prior unconditional-resume behavior.
  - **(A) Reactive safety net.** Generalize the previously Codex-only immediate-resume-crash fallback in `onExit` to **any** provider: a resume spawn (`resumeSessionId` *or* `providerThreadId`) that dies `<5s` with a non-zero code respawns fresh by **regenerating `providerSessionId`** (so Claude's pre-flight finds no JSONL for the new id → fresh `--session-id`) *and* clearing `providerThreadId` (Codex → fresh `--remote`). Regenerating the id is what breaks a would-be crash loop when a JSONL exists but is un-resumable (corrupt/pruned). B handles the common "never conversed" case before it ever crashes; A catches the residual "session existed but resume still failed" case.
  - Both fresh-fallbacks emit a `SystemNotification` so the dashboard explains why a fresh session appeared (B: "had no saved session to resume"; A: "couldn't resume prior session — starting fresh"), mirroring Codex's existing notice.
- **Rationale:** The disappearance is a recovery-asymmetry, not a persistence bug — the record is on disk the whole time; the fix is to stop a doomed resume from marking it crashed. A pre-flight (B) is deterministic and avoids the crash→respawn flicker and the alarming "died immediately — likely a bad flag" log entirely for the dominant case, while a regenerate-id safety net (A) guarantees recovery for the rare un-resumable-file case without crash-looping. Folding both providers onto one contract means the next provider to gain resume support (Gemini) inherits the parity instead of re-introducing the asymmetry.
- **Verification:** Real-spawn QA against the fixed code: an idle Claude agent (no JSONL) now resumes fresh-same-id and stays `running` (org chart shows it); a conversed agent (JSONL present) still takes the real `--resume` (not clobbered); a planted-but-invalid JSONL crashes `--resume`, then A regenerates the id and recovers it fresh — no crash loop, agent stays visible. Plus unit tests pinning `hasResumableSession` (true/false/cwd-scoped), the buildArgs resume-vs-fresh contract, and codex's no-hook parity.
- **Known minor:** the rare A-net path for Claude emits two notifications (A's own, then B's on the regenerated-id respawn) — both accurate; not worth threading a suppression flag for an uncommon case in a personal tool.
- **Alternatives considered:**
  - **Reactive-only (A alone)** — smallest diff, reuses the Codex pattern, but every never-conversed agent visibly crash→respawns each restart with a scary "bad flag" log, and it fires on transient failures too (could discard a recoverable session).
  - **Track a `hasConversed` flag** — new persisted per-agent state, more invasive, and still misses the "conversed-but-resume-fails" case.
  - **Leave Claude unconditional, document the gotcha** — rejected: the disappearing-agent UX is exactly the bug.
- **Source:** Terry's bug report (dev restart provider asymmetry); root cause + two-layer fix reproduced and verified empirically by DevRestartPersistence@autonomOS, approach approved by Terry directly.

## ADR-050: Retire pm2 from the operator path — `make prod`/`deploy` supervise via launchd/systemd-user (Option B)
- **Date:** 2026-06-29 — **Decided by:** Human (Terry), executed by ServerLifecycle@autonomOS. (ADR-049 was concurrently authored by PR #270; it merged first and took 049, so this is 050 — no renumber needed per the ADR-collision convention.)
- **Context:** Terry: *"pm2 has been working but also very painful — I'd like something more mainstream and reliable that works for both mac and linux."* A 10-tool market study (Tailscale, Ollama, Caddy, code-server, Supabase, Syncthing, n8n, + the agent-platform peers OpenClaw/Hermes/CMUX) found a unanimous norm: tools that ship a local daemon **supervise it with the OS-native init system** (systemd on Linux, launchd on macOS) — **none use a Node process manager (pm2/forever)**, which appears only in third-party blog posts. The norm has exactly two paths — *dev* (foreground, from source, no supervisor) and *vending* (the same binary wrapped in an init unit) — and **no third "operator" path**. autonomOS was already on-norm at both ends: `autonomos install-service` (shipped #170) writes a launchd LaunchAgent / systemd-user unit, and `make dev` runs foreground. The **only** off-norm element was pm2, which survived solely in the operator surface: `ecosystem.config.cjs`, the `Makefile` (`make prod`/`deploy`/`stop`/`logs`/`down`), and the remote-deploy SSH path that `bun add -g pm2`. Since *almost every existing user installs via `make prod`/`make deploy`*, that is exactly where the migration must live. (This also closes the long-deferred "Tier-1 PM2→npx" upgrade-UX item — picked up here, not reinvented.)
- **Decision:** Rip pm2 out of the operator path; `make prod` (and, via it, `make deploy`) now supervise the from-source server through the **same OS-native unit the vended install uses** — **Option B (source-pointing unit)**. Mechanics:
  - **`scripts/install-prod-service.sh`** replaces `pm2 start ecosystem.config.cjs`. It generates a tiny **wrapper** (`.autonomos-bin/autonomos`, gitignored) that execs `tsx --env-file=.env packages/cli/src/index.ts "$@"` — re-establishing the tsx loader + `.env` exactly like `make dev` — then points `install-service --bin=<wrapper> --port=3100` at it. `install-service`'s `detectProgramArgs()` can't express the tsx loader directly (process.argv would be `node foo.ts`), so the wrapper is the indirection that makes a source-pointing unit re-runnable. The script is **idempotent** (re-runs reinstall + `restart` so new source goes live; systemd `enable --now` won't restart an already-running unit, so the explicit `restart` is load-bearing) and runs **synchronously** with a post-boot smoke check.
  - **pm2 auto-migration (Q2 = AUTO):** the script detects a pm2-managed `autonomos` and runs `migrate-from-pm2` (stop + deregister pm2, preserve `PORT`) with a **loud announcement**, before installing the unit — unless **`NO_MIGRATE=1`** (escape hatch for CI / "I'll manage pm2 myself"). `install.sh` already auto-migrates curl installs, so all install paths converge.
  - **New CLI commands** (replacing `pm2 logs`/`pm2 restart`): **`autonomos logs`** (`-f`/`--lines`, tails the server-owned log) and **`autonomos restart`** (supervisor cycle). **`autonomos stop` is now service-aware** — under launchd `KeepAlive` / systemd `Restart=always`, a bare SIGTERM just gets revived, so when a service is installed `stop` tells the supervisor (`launchctl bootout` / `systemctl --user stop`) and `restart` uses `kickstart -k` with a `bootstrap` fallback (shared `lib/service-control.ts`). The pid-SIGTERM path remains for the no-service (foreground) case.
  - **Server-owned rotating log (Q3):** because launchd `StandardOutPath` / systemd `append:` make the *supervisor* hold the log fd (unbounded, un-rotatable from outside, and a second writer corrupts it), the **server owns its log**: `server/src/logger.ts` tees stdout+stderr into a size-rotating `$configDir/logs/autonomos.log` (synchronous fd appends; merged like pm2 `merge_logs:true`; keep newest N). It **echoes, never swallows**, so embedded stdout IPC + `--print-url` are unaffected. The service templates send the supervisor's stdout to **`/dev/null`** and keep only a tiny `autonomos.boot.error.log` stderr backstop. `autonomos logs` tails the rotating file.
  - **`ecosystem.config.cjs` deleted**; `make deploy` no longer installs pm2 on the remote; the systemd-user-over-ssh `XDG_RUNTIME_DIR` gotcha is handled in the script + `service-control.ts`.
- **Rationale:** Aligns with the unanimous market norm (OS-native init, no Node process manager) using infrastructure **already shipped in #170** — this is wiring + polish, not a new tool. launchd/systemd are dependency-free, survive reboot, restart on crash, and need no `bun add -g pm2`. Option B (source-pointing) fits the existing rsync-from-source `make deploy` model with the least disruption and keeps the fast iteration loop, mirroring Caddy's systemd unit running `caddy run`. Existing users keep typing `make deploy` and are migrated off pm2 seamlessly on the next run.
- **Alternatives considered:**
  - **Option A (build a bundle + supervise it)** — "truer vending," but adds a full bundle build to every `make prod`/forge deploy for no real gain on a from-source box.
  - **Option C (foreground-only `make prod` + manual `install-service`)** — simplest, but under-serves an always-on box and is easy to forget.
  - **A new supervisor (Foreman/Overmind, Docker, custom daemon)** — rejected: adds a dependency or reinvents launchd/systemd; Docker specifically fights autonomOS's host-PTY agent spawning. **pm2 itself** — the thing we're leaving; `pm2 startup` needs sudo and is fragile, and it's off-norm.
  - **In-code rotation of the supervisor's own logfile** — rejected: the supervisor holds the fd, so external rotation writes to the unlinked inode; the server must own the log instead.
- **Validation:** Two-stage QA on an isolated config dir + port 3199 (never :3100): (1) wrapper→server boot, server-owned log, `status`/`logs`/`stop`; (2) a full real-launchd cycle — install → KeepAlive-supervised → `stop` (bootout) **stayed down** (no revive) → `restart` (bootstrap) back up → `uninstall` clean. Unit tests cover the rotating writer and the `/dev/null` template redirect.
- **Scope:** This ADR is the lifecycle swap (PR1). The first-run install-UX revamp (post-install smoke test surfaced to curl installs, URL/token print, browser/PWA auto-open) is a stacked follow-up (PR2) with its own ADR. Brew remains for the (now-cut) desktop app only; the server install story is `curl install.sh` + `make deploy`. Relates to the desktop-app cut (server-first product) and #170 (the install-service foundation, which **stays**).
- **Source:** autonomOS CC session, ServerLifecycle@autonomOS worker; direction (Option B, auto-migrate, server-owned rotating log, delete ecosystem, 2 stacked PRs) decided by Terry across the session; market study via parallel research subagents.

## ADR-051: Cut the Electron desktop app — remote always-on server is the canonical deployment
- **Date:** 2026-06-29 — **Decided by:** Human (Terry) via TeamLead@autonomOS, implemented by ElectronCleanup@autonomOS
- **Context:** autonomOS spent 6+ months building an Electron desktop app across four architectural pivots — ADR-005 (web-first, "package as Electron later"), ADR-028 (pure thin client), ADR-029 (Built-in embedded server, reversing part of 028), ADR-030 ("Try it out" ephemeral mode) — plus a deep release-infrastructure investment: universal2 DMG lipo, Developer ID signing, Apple notarization (85min+ stalls — see [[project_mac_signing_notary]]), electron-updater, a bundled-Node + napi-rs universal-binary chain, and CDP-driven DMG validation gates on every PR. That Electron layer became the single most expensive maintenance surface in the repo for little realized value: the desktop app was not how the product was actually used. The intended user (Terry) runs autonomos-server on a remote always-on host (forge) reached via browser/PWA — structurally the n8n-self-hosted pattern ADR-028 itself cited as the long-run winner. The real need behind "desktop app" was always "agents stay alive when my laptop is closed" = a **remote always-on server**, not a local GUI shell. The PWA shipped in #71 already covers the installable-app / desktop-notifications / thin-client value at zero Electron cost.
- **Decision:** Cancel the Electron desktop-app initiative entirely. Delete `packages/app/` (the whole Electron source tree, ~9.5k LOC), the server-side embedded-mode coupling (`embedded-mode.ts` + the `--embedded` flag in `cli-args.ts`/`run.ts`/CLI help), and the desktop half of the release pipeline (electron-builder, DMG/ZIP/blockmap build, code-signing, notarization, the `build-dmg`/`validate-intel` CI jobs, electron-updater feed, `pr-artifact.yml`). The canonical deployment is **autonomos-server supervised as an always-on daemon (launchd/systemd-user, ADR-050), reached via browser or PWA**. Three pieces that ADR-028/029/030 established and that are independent of the desktop are explicitly **retained**: (1) the launchd/systemd-user server lifecycle (ADR-028 core; ADR-050 finished the pm2→launchd/systemd cutover), (2) the pid-file mutual-exclusion lock (ADR-029 core; still prevents two daemons racing on `~/.autonomos/`), and (3) the `auth.ts` CONFIG_DIR-aware token isolation (ADR-030 server-side; serves worktree-dev and future profiles). The dashboard-embedded-in-server-binary bundle (`_embedded_dashboard`, ADR-043) is unrelated to Electron's `--embedded` and is untouched — a naming collision worth calling out: **we deleted Electron embedded-mode; we kept dashboard-embedded-in-server-bundle.**
- **Rationale:** Maintenance cost vastly exceeded value — signing/notary stalls, electron-updater, universal lipo, and the bun-compile/node-pty ABI wall consumed disproportionate engineering for an unused layer. The browser/PWA (#71) already delivers the desktop app's entire user-facing value without a native bundle to sign/notarize/auto-update. The always-on server is the actual product need (agents run while the user is away — a supervised daemon's job, not a GUI session's; ADR-028 articulated this and we are following it to its conclusion). Converges with always-on agent-platform peers (OpenClaw, Hermes) that bet on a persistent daemon + thin clients rather than a bundled desktop stack; the bundled-server-with-GUI lineage (n8n Desktop, sunset 2023) is the cautionary pattern.
- **Alternatives considered:** (a) Keep Electron as an opt-in build — rejected: an unused build target still pays the full signing/notary/CI tax and rots. (b) Slim down Electron (unsigned, no auto-update) — rejected: an unsigned macOS app triggers Gatekeeper friction on every launch, worse than the browser, and still carries the bundled-Node chain. (c) Ship a native (Tauri/Swift) Mac app — rejected: re-investing in any local GUI shell repeats the category mistake; the need is remote always-on. (d) Status quo — rejected: most expensive surface for the least realized value.
- **Implications:** Five GitHub Actions secrets (CSC_LINK, CSC_KEY_PASSWORD, APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER) become unused — flagged for manual deletion by Terry post-merge (not deleted by the PR; `gh secret set --body -` is a footgun, so safer to flag). Release version source moves `packages/app/package.json` → `packages/server/package.json`; `@autonomos/app` leaves the changeset `fixed` group (cli/core/dashboard/server stay locked). `reusable-dmg-build.yml` is gutted to its `build-server` job (source of the install.sh server tarballs) and renamed `reusable-server-build.yml`, not deleted. **Mid-execution refinement:** the shared CI-only real-spawn integration harness `helpers/embedded-server.ts` — used by 4 suites (only one of which was the embedded test), not Electron-specific — depended on the going-away `--embedded` flag + `AUTONOMOS_READY` stdout signal purely for ephemeral-port readiness; it was rewritten to parse the server's always-emitted "listening on …:<port>" startup log and renamed `helpers/test-server.ts` (`bootEmbedded`→`bootServer`), preserving the 3 non-Electron suites. ServerLifecycle@autonomOS's install-UX work (PR2) stacks cleanly: the only shared file (`cli/install-service.ts`) is touched here only to reword a now-obsolete "quit the Desktop app" error string — the pid-file mutual-exclusion check it lives in is preserved.
- **Supersedes / amends:** Adds Update notes to ADR-005, ADR-028, ADR-029, ADR-029-follow-up, ADR-030 (the Electron-coexistence portions are now N/A; the launchd/systemd lifecycle and pid-file lock and token-isolation cores remain in force). Relates to ADR-050 (the always-on lifecycle this cut leans on) and ADR-043 (the dashboard-embedded bundle, explicitly NOT affected).
- **Source:** TeamLead@autonomOS channel directive (2026-06-29) + ServerLifecycle@autonomOS always-on research relay; propose-pause punch-list approved by Terry via TeamLead.

## ADR-052: First-run install UX — post-install smoke test + surfaced connect panel
- **Date:** 2026-06-29 — **Decided by:** Human (Terry), executed by ServerLifecycle@autonomOS. (ADR-051 is reserved for the concurrent ElectronCleanup PR per the later-merger convention; this is the install-UX follow-up to ADR-050.)
- **Context:** PR1 (ADR-050) moved supervision to launchd/systemd-user but `install-service` still ended with the un-verified line *"daemon should be running shortly"* and never surfaced where to reach the dashboard. A first-time `curl install.sh | sh` user got a binary and a service file but no confirmation it worked and no URL/token — the exact friction this initiative set out to remove. Two facts shape the fix: a **default** install binds `:3000` while only `make prod` forces `:3100` (so the port can't be assumed — it must be read from the pid file the daemon writes on boot), and the auth **token** is written to `$configDir/token` on first boot (so it's readable once the daemon is up).
- **Decision:** Add a shared **post-install verifier** (`cli/lib/post-install.ts`) that `install-service` calls after activation (both platforms). It **polls until the daemon is actually responsive** (pid file present + pid alive + port answers `/api/system/version`, ~12 s budget) — a real smoke test that replaces the guess — then prints a **connect panel**: the dashboard URL (from the pid file's real port), the token (from `$configDir/token`), a click-to-auth `…/auth?token=…` link, and the manage commands. On timeout it degrades to an actionable warning (`check autonomos status / logs`) rather than a false success; it never throws (the service file is written regardless). A new **`--open`** flag best-effort opens the dashboard in a browser (`open`/`xdg-open`), and **no-ops on headless boxes** (no `DISPLAY`/`WAYLAND_DISPLAY`) and under `CI`. `install.sh` passes `--open` only on an interactive terminal (`[ -t 1 ]`, opt-out `AUTONOMOS_NO_OPEN=1`) and its closing message now points at the panel instead of a bare `autonomos status`.
- **Rationale:** "Open the app, it just works" is the Docker-Desktop/Ollama bar for a local daemon; the verifier turns a silent install into a confirmed one and hands the user a one-click way in. Reading port+token from the daemon's own on-disk state (not assumptions) makes the panel correct for every install shape (`:3000` curl install, `:3100` make prod, or an OS-assigned port). Best-effort browser-open with headless/CI guards gives the magic on a laptop without misbehaving on a forge box.
- **Alternatives considered:**
  - **Always auto-open the browser** — rejected: wrong on headless servers and in piped/CI installs; gated behind `--open` + interactivity + display checks instead.
  - **Auto-append `export PATH=…` to the user's shell rc** — deferred: editing a user's rc from a piped `curl | sh` is an invasive footgun; the existing PATH hint is kept and an explicit offer can come later.
  - **Print a fixed `http://localhost:3100`** — rejected: wrong for the default `:3000` install and OS-assigned ports; the pid file is the source of truth.
- **Validation:** Unit tests for the panel (URL+token+auth-link), the env-token fallback, and the no-daemon warning (short timeout). Real-launchd QA on an isolated config dir + `:3199`: `install-service` polled the daemon up and printed the correct URL + real on-disk token + auth link; `:3100` untouched, clean teardown.
- **Scope:** PR2 (stacked on the merged ADR-050). Closes the Tier-1 install-UX gap for the server-first product (the desktop app is being cut separately).
- **Source:** autonomOS CC session, ServerLifecycle@autonomOS worker; install-UX revamp directed by Terry; ADR number coordinated with TeamLead@autonomOS (051 → ElectronCleanup, 052 → this).
- **Update (2026-06-29, security hardening — token-in-URL removed):** An automated security review of #272 flagged that the connect panel's click-to-auth `…/auth?token=<token>` link leaked the admin token three ways: printed to stdout (shell scrollback / CI logs), passed to the browser-opener so it shows in `ps` process args (any UID on a shared host) and persists in browser history. Root-cause investigation found the link was **also non-functional**: there is no `GET /auth` route that consumes the query token, and the dashboard frontend never reads `?token=` from the URL — it shows a login page that POSTs the token in the request *body* (the leak-free path), so the user **always paste-authenticated anyway**. The link was therefore a leaky, broken non-feature, not a convenience worth preserving. **Fix:** removed the `?token=` URL from both the printed panel and the `--open` browser target (now opens the dashboard *root*); the token is surfaced only on stdout — the operator's own terminal, the lowest-severity surface, and the value they paste at the login (this is required for the remote `make deploy` case, where the browser is on a different host than the server). The misleading server 401 message ("visit /auth?token=YOUR_TOKEN") was reworded to "paste your token at the login screen". The multi-user `--open` gate the review suggested became unnecessary (no secret in the opener URL). **Deferred follow-up:** `requireAuth` still *accepts* `?token=` as a query param (run.ts) for `/api/*` `/ws/*` — closing that accept-side vector is a separate hardening change with its own risk surface (possible curl/script consumers). The one-shot bootstrap-file auto-auth (zero-paste) was also deferred — it's net-new auth surface, only helps local installs, and the current paste flow is the unchanged baseline. (PR for this update: the post-install token-security patch.)

## ADR-053: Compaction status is order-independent — no assumed hook delivery order (structural fix, no watchdog)
- **Date:** 2026-07-11 — **Decided by:** Human (Terry) via TeamLead@autonomOS, investigated + implemented by PostCompactStatus@autonomOS
- **Context:** Claude Code sessions showed the dashboard "compacting" spinner and **never recovered** after a compaction — a persistent, intermittent bug that survived a prior fix (#154, which added `preCompactStatus` save/restore to `routes/hooks.ts`). Empirical investigation (a real spawned CC 2.1.207 session relaying all 13 hooks to a capture sink, plus a real `/compact` trigger) established the actual event stream for a **successful** manual `/compact`: `PreCompact → SubagentStop → SessionStart(source=compact) → PostCompact` — with the trailing **trio firing within ~90 ms**. Two facts make delivery order non-deterministic: the relay hooks are configured `async: true` fire-and-forget curls (`providers/claude-code.ts`), and each is a separate short-lived `curl` process, so arrival order at the server is a race. `deriveStatus()` mapped `SessionStart(source=compact) → "compacting"`, and #154's save/restore **assumed** `SessionStart(compact)` always arrives *before* `PostCompact` — its unit tests encoded only that one safe ordering. A deterministic probe replaying the real event set through the actual `hooksRouter` in all 6 orderings of the racing trio showed **2/6 strand the agent at "compacting" forever** (every order where `SessionStart(compact)` lands last: it re-enters "compacting" *after* `PostCompact` already resolved, and a manual `/compact` — or a resume auto-compact — has no trailing `Stop`/turn to self-heal). Also observed: two compaction **failure** modes ("Not enough messages to compact", "Error during compaction: summarization produced empty response") where CC fires `PreCompact` but **never** `PostCompact` — harmless from idle (PreCompact is dropped by the sticky-idle guard) but relevant to fix robustness. Notably, the official CC hooks docs claimed the order `PreCompact → PostCompact → SessionStart(compact)` — the **reverse** of reality — reinforcing the ADR-027 (Gemini `PreCompress`) lesson: *vendor docs give you event names; only empirical capture gives you firing order*.
- **Decision:** Move compaction ownership out of `deriveStatus()` and into the router as an **order-independent** state machine (`routes/hooks.ts`):
  - **`PreCompact`** enters `"compacting"` and saves `preCompactStatus = prev.status` — but **only from an actively-working state** (an allowlist `COMPACT_ENTER_FROM = {working, tool_running, orchestrating, needs_input, error}`, fail-safe by construction). From any at-rest state (`idle`/`stopped`/`ready`/`unknown` — a `/compact` with no live turn to interrupt) it is a no-op, so a failed compaction can't strand it; and from `"compacting"` itself (a duplicate/overlapping `PreCompact`) it is a no-op, so the saved baseline is never overwritten with the spinner state. `restoredStatus()` additionally coerces a `"compacting"` baseline → `"working"` as defense-in-depth.
  - **`SessionStart(source=compact)` and `PostCompact`** are both treated as **idempotent "compaction resolved" signals**: whichever arrives first restores the saved baseline (coercing transient `tool_running`/`needs_input`/`error` → `working`) and clears it; whichever arrives second is a no-op. From a cold store (`unknown`, resume auto-compact with no captured baseline) a resolve signal goes **straight to `ready`** — no spurious "compacting" flash for something the user didn't initiate (Q1).
  - The compaction summarizer's **`SubagentStart`/`SubagentStop` are ignored while `"compacting"`**, so the spinner stays stable until a resolve signal rather than flickering to orchestrating/working.
  - Any **non-compaction** status change clears `preCompactStatus`, so a baseline can't leak into a later cycle.
- **Explicitly NO watchdog timer.** The structural fix makes the normal path correct for **all** delivery orders (verified: 0/6 stranded), which is the complete root cause of the reported bug. A fallback timer was designed (arm on entering "compacting", force-restore after ~120 s) to also cover the silent-failure modes and future CC drift, but Terry chose the minimal structural-only scope: those residual cases are rare and self-heal on the next real turn event, and a timer adds arbitrary-timeout tuning + per-session lifecycle bookkeeping for marginal value. **This is recorded deliberately** — if CC changes its compaction hooks again and a silent-no-resolve case starts stranding agents, the watchdog is the known next step.
- **Rationale:** The bug was never a missing handler — it was a state machine that threaded status across a *sequence* of hook events whose order the async fire-and-forget transport doesn't guarantee. Idempotent resolve signals remove the ordering assumption entirely, which is both simpler and strictly more correct than trying to enumerate/repair each bad order. Keeping `deriveStatus()` a pure per-event mapper and localizing the order-sensitive logic in the router keeps the two concerns separate.
- **Alternatives considered:** (a) **Watchdog timer only (Option A)** — masks the race with an arbitrary timeout instead of fixing it; drifts if CC changes emission timing. (b) **Hybrid: structural + watchdog (Option C)** — TeamLead's initial approval; belt-and-suspenders, but the watchdog's extra surface wasn't warranted once the structural fix proved to cover 0/6 stranded (Terry's call). (c) **Add `PostCompact` to `IDLE_EXIT_EVENTS`** — insufficient: `SessionStart(compact)` (already an idle-exit event) still re-enters "compacting" last and strands. (d) **Track a per-session compaction "generation" token** to reject a late `SessionStart(compact)` — more state and still order-sensitive; idempotent resolve is cleaner.
- **Validation:** (1) Empirical repro — real CC 2.1.207 spawn + hook sink captured the true event order and the two failure modes. (2) Deterministic reorder probe through the real `hooksRouter`: **before** = 2/6 stranded; **after** = 0/6, across idle / mid-turn(working) / resume(unknown) scenarios. (3) Unit tests: a `compaction order-independence` suite replays **all 6 orderings** for idle→idle and mid-turn→working, both resume orders → ready, plus the summarizer-noise, duplicate-`PreCompact`, `/compact`-from-`ready`, and `PreCompact`-last self-heal cases — closing #154's single-order blindspot. (4) `/qa` real spawn + real `/compact` + auto-compact. Isolated env throughout (port 3199 + isolated `AUTONOMOS_CONFIG_DIR`; never `:3100`).
- **Polish hardening (silent-failure review):** the initial fix scoped its "order-independent" proof to permutations of the trailing trio while holding `PreCompact` first, which left two residual strands the review caught: (a) a **duplicate/overlapping `PreCompact`** re-entered `"compacting"` and overwrote the baseline with the spinner state (a regression vs #154's `prev.status !== "compacting"` guard), and (b) `"ready"` was an at-rest state that wasn't excluded, so a `/compact`-at-`ready` that then *failed* couldn't self-heal. Both were closed by replacing the enter **blocklist** with an **allowlist** of genuinely-active statuses (fail-safe: any unlisted state no-ops), plus the `restoredStatus` `"compacting"`→`"working"` coercion. The remaining theoretical `PreCompact`-last reorder can only enter `"compacting"` from an active state (the allowlist), which always self-heals on its trailing `Stop`/tool event — so it cannot permanently strand an at-rest or resume compaction.
- **Amends:** Supersedes the order-dependent portion of **#154** (post-compaction stuck-status fix — its `preCompactStatus` field is kept and generalized; its single-order tests are updated). Relates to ADR-027 (Gemini `normalizeEvent`/`PreCompress` — same "docs lie about firing semantics, capture the source" lesson).
- **Source:** autonomOS CC session, PostCompactStatus@autonomOS worker; propose-pause root-cause + fix options approved by Terry; scope narrowed from Hybrid (C) to structural-only (B) by Terry's direct override.


---

## ADR-054: Auth on /mcp closes an unauthenticated RCE; bind default unchanged
- **Date:** 2026-07-17 — **Decided by:** Human (Terry: "can we always require auth? hard requirement", then steered the bind decision after describing how users actually reach the server — Tailscale `dev-server:3100`, GCP IAP port-forward, SSH to the public IP), investigated + implemented by AppSecurityAudit@autonomOS under TeamLead@autonomOS lead
- **Context:** A broad app-security audit (non-token surfaces) found two defects that composed into **unauthenticated remote code execution**, verified live against both the local server and `forge` — not inferred from reading code:
  1. `requireAuth` was mounted on `/api/*` and `/ws/*` only. `/mcp` — the Streamable-HTTP transport exposing `create_agent`, `kill_agent`, `set_manager` — matched neither prefix and had no internal check. An unauthenticated `POST /mcp initialize` returned `200` + a session id; `tools/list` then enumerated the full orchestration toolset.
  2. `serve()` was called with no `hostname`, so Node bound `::`/`0.0.0.0`. Confirmed live: `node … TCP *:3100 (LISTEN)`.
  Together: any host on the same network could open an MCP session with one `curl` and `create_agent` with `permissionMode: "bypass"`, an arbitrary `workingDirectory` (`runtime.ts` checks existence only), and an arbitrary prompt → arbitrary code execution as the server's user. The repo is public with tagged releases, so this shipped to users, whose laptops run on untrusted networks (café/office/dorm). CVSS ≈ 9.8.
- **Decision:** (a) Mount `requireAuth` on `/mcp`, checked at the transport boundary so an unauthenticated caller cannot complete `initialize` and never obtains the session id later calls need. **This alone closes the RCE.** (b) **Leave the bind default unchanged** — all interfaces — and add `--host` / `AUTONOMOS_HOST` (unset → `undefined` → Node's dual-stack default) as an opt-in to *restrict* to loopback, threaded through `install-service` → `install-prod-service.sh` → `Makefile` (`BIND_HOST`). (c) A non-loopback bind logs one **informational** startup line that names the still-unauthenticated routes; a loopback-restricted bind is silent.
- **Rationale:** The RCE is closed by auth on `/mcp`, not by the bind — so the bind default is a compatibility choice, not a security necessity, and it must match how the software is actually deployed. Terry's users overwhelmingly run the server on a remote box and reach it over the network: Tailscale MagicDNS to `dev-server:3100`, GCP IAP TCP-forwarding to a local Mac, or SSH to the box's public IP. A loopback default breaks the first two outright (both need a real network interface; `0.0.0.0` is a superset that also answers loopback, so it serves the SSH-tunnel case too). An earlier revision of this PR defaulted to loopback and would have silently broken those users on upgrade — caught before merge. So: keep the long-standing all-interfaces bind, let the operator's existing network controls (Tailscale ACLs, GCP firewall + IAP, SSH) gate *who reaches the port*, and let the token gate *what they can do*. `--host=127.0.0.1` is there for the SSH-tunnel user who wants to tighten. Auth costs nothing because `auth.ts` has always generated + persisted a random 256-bit token on first start (`randomBytes(32)`, `0600`) — there is no tokenless state to design for.
- **Alternatives considered:**
  - *Revive `isLoopbackBind` to gate the exemptions* — rejected. It preserves the "trusted context" idea that failed here in the first place (see the correction below).
  - *Peer-address gate on `/api/hooks/*`* (hook traffic is always loopback: `shared.ts` hardcodes `AUTONOMOS_SERVER=http://localhost:…`) — designed and rejected in favour of Terry's always-auth rule. Retained as the fallback if authenticating the relay proves impractical. It carried three landmines worth recording, all empirically probed: `::ffff:127.0.0.1` must PASS (a `::1`-only check 401s every hook → fleet-wide status blackout); `startsWith("::ffff:")` is a TOTAL bypass (it prefixes any IPv4); and loopback is all of `127/8`, not `127.0.0.1` — `127.0.0.53` is loopback on Linux (systemd-resolved) but unreachable on macOS, so an `=== "127.0.0.1"` check passes QA on a Mac and is wrong on forge.
  - *Bind forge to its tailnet IP (`100.69.245.108`)* — smaller surface, rejected as the default: it fails with `EADDRNOTAVAIL` if `tailscaled` isn't up yet (forge is systemd), and with auth universal the bind is no longer the boundary. `0.0.0.0` + Tailscale as defense-in-depth is the pragmatic shape.
  - *Hotpatch `hostname: '127.0.0.1'` + firewall* — considered as an emergency mitigation; unnecessary once the real fix was small enough to ship directly.
- **Correction to the record (this audit's own finding, retracted and re-derived):** the audit first reported `isLoopbackBind` (`run.ts`, zero callers) as "designed and never wired up." **Wrong.** `git log -S`: #221 added it *with* its caller *and* a locking test; #264 removed the claude-usage harvest endpoint and deleted both, orphaning the helper. The corrected story is worse: **ADR-041 already recorded that unconditional auth-exemption is a HIGH-severity credential-injection vector on non-loopback binds** (found by `/polish`, fixed pre-ship for that one endpoint). `/api/hooks/*` is the "existing localhost-trust model" ADR-041 says it was *mirroring but chose to be stricter than* — and it was left unconditionally exempt on every bind. The lesson was written down, applied once, and never applied to the neighbour it was copied from; then the only test encoding it was deleted as collateral. **A deleted test is how a security invariant dies quietly** — removing the endpoint made removing its test look like hygiene, and nothing failed. The new tests are attached to the bind logic itself, not to any endpoint's lifetime.
- **Known residual (NOT closed here):** `POST /api/hooks/*` and `GET /api/host` remain unauthenticated on every bind. They cannot spawn or control agents, but an unauthenticated caller can forge agent status, inject dashboard notifications (incl. the `proactive: true` push path), and drive the prompt-delivery state machine. Deliberately deferred: authenticating the relay changes how the token *travels* (TokenSecurityAudit@autonomOS's scope) and risks a fleet-wide status blackout if the token fails to reach the hooks — that needs its own PR with a real-spawn `/qa`, not an emergency patch. Until then every operator-facing string **names** this gap instead of claiming blanket coverage.
- **Not a breaking change:** the bind is unchanged (all interfaces), so every network-reached dashboard keeps working on upgrade with no `.env` edit. `resolveBindHost` returns `undefined` when unset and passes that straight to `serve()` — Node's `::` dual-stack default, byte-identical to the prior no-hostname behavior (deliberately not the string `"0.0.0.0"`, which would be IPv4-only and could drop an IPv6 client). The follow-up two-listener separation (ADR-055, planned) is what actually removes the network exposure of the internal control plane (`/mcp`, `/ws/gateway`, `/api/hooks`) by binding it loopback-only.
- **Note:** Composes with ADR-050/052 (launchd/systemd-user supervision — `--host` threads through the same installer path). The **Phase 2 separation** is the intended follow-up: `/mcp` + `/ws/gateway` + `/api/hooks/*` move to a loopback-only internal listener (agents already reach them via `localhost`), which physically closes this RCE a second way plus the gateway register-spoofing and the `/api/hooks` residual below.
- **Source:** autonomOS CC session, AppSecurityAudit@autonomOS worker, propose-pause audit + fix plan approved by Terry; `/mcp` chain proven live (stopped at `tools/list`, never called `create_agent`). Two candidate findings were retracted as false positives after empirical checks — a slash-normalisation auth bypass (`//api/agents` → 200 is the SPA static fallback; the handler-vs-router 404 shape disproved it) and CSWSH from a third-party origin (SameSite=Lax withholds the cookie on a subresource WS handshake).

---

## ADR-055: Unix-socket internal control plane + per-agent identity (the "secure by construction" end state)
- **Date:** 2026-07-18 — **Decided by:** Human (Terry — chose the long-term best-practice architecture over the pragmatic peer-gate after understanding the tradeoffs; explicit requirement: "only autonomOS-spawned agents may use /mcp, no external MCP client"), designed by AppSecurityAudit@autonomOS under TeamLead@autonomOS
- **Context:** ADR-054 (Phase 1) closed the `/mcp` RCE with auth but deliberately left a residual: `POST /api/hooks/*` and `GET /api/host` stay unauthenticated on every bind, and the gateway `register` accepts any client-asserted agent name (spoofing). The audit's Phase-2 goal was to remove the *network exposure* of the internal control plane entirely. Two implementation shapes were weighed:
  1. **Loopback-peer gate** (one TCP listener, reject non-loopback peers on the internal routes) — low risk, but a "soft" application-layer check with known landmines (`::ffff:` mapping, `127/8`, reverse-proxy confusion), and still a TCP port any *local* user can reach.
  2. **Two loopback-TCP listeners** — kernel-enforced, but requires untangling env vars welded across the boundary (`AUTONOMOS_SERVER` serves both `/api/hooks`→internal AND statusline `/api/agents`→public; `AUTONOMOS_SERVER_URL` serves both gateway-WS→internal AND the channel-server's REST base→public), touching agent-spawn-critical paths.
  Exploring #2 surfaced that the *best* answer is neither: take the internal plane **off TCP entirely.**
- **Decision:** Four layers, "make the secure state structural, not a check":
  1. **Internal control plane on a Unix domain socket.** `/mcp`, `/ws/gateway`, `/api/hooks/*` move off TCP onto `~/.autonomos/control.sock` (mode `0600`). The public listener (`3100`, all interfaces, strong token) serves ONLY the browser surface. A socket is reachable only by processes running as the server's user on the box — which is exactly what an autonomOS-spawned agent is, and exactly what an external client is not. This satisfies Terry's `/mcp` requirement structurally: on-box same-user = allowed, everything else = the OS won't open the socket. Strictly better than loopback TCP, which any *local* user can reach and which needs peer-parsing/bind-config to get right.
  2. **Public listener = browser UI only**, every route behind the strong 256-bit token (a weak operator-set `AUTONOMOS_TOKEN` — e.g. forge's 4-char value — is an anti-pattern to reject/warn on), TLS or encrypted-tunnel-only for untrusted networks.
  3. **Per-agent gateway identity.** Replace "register as any name" with a per-agent credential issued at spawn, so messages are attributable and un-spoofable (closes the register-hijack from the audit).
  4. **Clean single-purpose env contract.** Split the overloaded `AUTONOMOS_SERVER` / `AUTONOMOS_SERVER_URL` into per-plane vars (the welding is what breeds the next regression).
- **Technical approach (feasibility confirmed):** `@hono/node-server`'s `serve()` is port-only, but it exports `createAdaptorServer` — the internal listener is `createAdaptorServer({ fetch: internalApp.fetch }).listen(socketPath, cb)` + its own `createNodeWebSocket({ app: internalApp })` / `injectWebSocket(internalServer)` (per-app closures, no singleton conflict with the public app). Client side: `curl --unix-socket <sock> http://localhost/api/hooks/...` (HOOK_CMD), `ws+unix://<sock>:/ws/gateway` (channel-server gateway), and an explicit public REST base for the channel-server's `create_agent`/`schedules` calls (decoupled from the WS URL — layer 4). Lifecycle init (setServerPort, pid-file acquire, gateway init, resumeActiveAgents) runs ONCE in the public listener's callback, not per-listener. The `autonomOS server listening on <url>` banner stays unique to the public listener (helpers/test-server.ts parses it).
- **Why NOT the alternatives:**
  - *Peer-gate* — superseded the moment the socket lands (would be dead code); a soft check where the socket is a hard OS fact. Rejected as the end state; not even worth as an interim since the RCE is already closed (ADR-054) so there is no urgency forcing a stopgap.
  - *Two loopback-TCP listeners* — kernel-enforced but still a port every local user can reach, still needs the env untangling, and offers nothing the socket doesn't. The socket does the same isolation AND closes the local-user gap AND has zero config surface.
  - *Delete HTTP /mcp entirely* — viable (nothing autonomOS uses HTTP /mcp; agents get the tools via the stdio channel-server), but socket-binding is the reversible choice that keeps the capability locked to on-box.
- **Sequencing:** **PR A** — socket internal plane + clean env contract (layers 1+4), verified with a real nested agent spawn (hooks land, `send()` delivers, agent-spawns-agent works). **PR B** — per-agent gateway identity (layer 3), separate test. Strong-token enforcement (layer 2) folds in along the way. Go straight to the socket; skip the peer-gate.
- **Known scope/risk:** touches every agent-connectivity path (hooks curl, gateway WS, channel-server REST, provider env injection in claude-code/codex/gemini, the pre-existing `gemini-cli.ts` `process.env.PORT` bug). Mandatory real-spawn `/qa` before merge — a mistake here breaks agent spawning or inter-agent messaging, not just a route.
- **Note:** Supersedes ADR-054's deferred residual (closes `/api/hooks` network exposure). Also incidentally fixes the pre-existing HTTP `/mcp` "Already connected to a transport" single-session bug found during ADR-054's forge test, since the transport lifecycle gets reworked here. Relates to ADR-041 (localhost-trust — now *removed* via structural isolation rather than gated) and ADR-050 (launchd/systemd-user supervision — the socket path lives under the same `~/.autonomos/` the service already owns).
- **Source:** autonomOS CC session, AppSecurityAudit@autonomOS; Terry chose the best-practice end state over the pragmatic shortcut and set the "autonomOS-agents-only /mcp" requirement that the socket enforces by construction.
- **Update (2026-07-18, implementer — PR A):** Two corrections found while implementing, recorded append-only rather than editing the entries above.
  1. **The "incidentally fixes the `/mcp` *Already connected to a transport*" claim is wrong.** That 500 is still reproducible after the socket move. Root cause is `packages/server/src/mcp.ts` — a single module-level `mcpServer` whose `.connect(transport)` is called once per `initialize`, so the second session throws. Moving the *listener* to a Unix socket does not touch the *transport lifecycle*, and `mcp.ts` is unmodified by this PR. The bug is pre-existing, unchanged, and tracked as its own follow-up (out of scope for PR A and PR B).
  2. **`/ws/gateway` is deferred from PR A to PR B.** The channel-server dials the gateway with the **global** `WebSocket` (Node/undici), not the `ws` package — and undici rejects `ws+unix:` outright (`DOMException: expected a ws: or wss: url`); `ws` is not a dependency of `packages/server` either. Since `/ws/gateway` is already token-gated under `/ws/*` (unlike `POST /api/hooks/*`, which was unauthenticated — the actual residual this PR closes), deferring leaves no unauthenticated network surface. PR B consolidates the gateway move with layer 3 (per-agent identity), the `ws` dependency, the `AUTONOMOS_SERVER_URL` split, the channel-server REST decouple (`AUTONOMOS_API_URL`), and the pre-existing `gemini-cli.ts` `process.env.PORT` bug — one gateway rework, one real-spawn QA. Verified for PR B: `ws@8.19.0` sets `opts.path = pathname + search` *before* splitting on `:`, so `ws+unix://<sock>:/ws/gateway?token=…` preserves the token query unchanged; a `:` in the socket path would truncate it, hence the boot-time guard added here.
  - **Also delivered in PR A beyond the original layer-1 sketch:** `/api/hooks` turned out to be *two* surfaces sharing a prefix — agent **ingest** (`POST /:sessionId`, moved to the socket) and dashboard **reads** (`GET /`, `GET /notifications`, `GET /:sessionId/status|notifications`, `POST /:sessionId/read`, all still called by the browser and therefore still public + token-gated). Only ingest moved; the routers are now split (`hooksIngestRouter` / `hooksReadRouter`). Consequently the `POST /api/hooks/*` auth exemption was **deleted** — it was broader than its purpose (it also exempted the dashboard's `/read`), and with ingest off the public listener there is now no unauthenticated POST anywhere on the public surface.
- **Update (2026-07-25, implementer — PR B):** Layers 1 (gateway leg) + 3 shipped; layer 2 (strong-token enforcement) and the delivery-ack cleanup deferred with reasons. Two commits on `terry/security-gateway-identity`.
  1. **Gateway moved onto the socket.** `/ws/gateway` now serves on the internal Unix socket via a per-app `createNodeWebSocket`/`injectWebSocket` for `internalApp`; the channel-server dials `ws+unix://<socketPath>:/ws/gateway`. Required adding **`ws` as a direct dep** of `packages/server` (Node's global/undici WebSocket rejects the scheme — the exact reason PR A deferred this) and `import WebSocket from "ws"` in the channel-server; the esbuild bundle keeps it external (`--packages=external`) and resolves it at runtime like the other externals. Empirically verified: a real `claude` agent's channel-server connects over `ws+unix` and the `?token=` query survives ws's `:`-split.
  2. **Per-agent identity (layer 3).** New in-memory, session-keyed credential store (`agentCredentials.ts`): a token minted at spawn (idempotent per session), injected as `AUTONOMOS_AGENT_TOKEN` into the agent env (for the hook curl, sent as `X-Agent-Token` via an unexpanded `${...}` ref so it never hits process argv) and the channel-server env (claude/codex explicit; gemini inherits from the agent process env). The gateway `register` and hook ingest both verify it (constant-time, fail-closed); a missing/wrong/unknown-session token is rejected. **Ephemeral by design** — never persisted, re-minted on every (re)spawn, revoked at the `markExited` chokepoint. This closes the register-spoof (the client-asserted `sessionId` that `routeMessage` trusted as sender identity) and hook forgery.
     - **Honest scope, recorded so it isn't oversold:** all agents run as the same Unix user, which can read any sibling's `/proc/<pid>/environ`. So per-agent identity is **defense-in-depth + attribution**, NOT a kernel-hard wall against a malicious on-box agent scraping a sibling's token. It raises spoofing from "assert any name in a JSON message" to "actively read another process's memory," and makes every message attributable. Terry's call to gate hook ingest too (not just the gateway) was taken; the credential is a per-agent secret distinct from the global `AUTONOMOS_TOKEN`, but hooks and gateway share the SAME per-agent token (separating them adds mint/verify surface for marginal benefit given same-user readability).
     - **argv exposure — env-only on the HOOK path, not everywhere (nox review catch, #293):** the "the token never appears in argv" property holds only for the hook curl (the `${AUTONOMOS_AGENT_TOKEN}` shell ref is unexpanded in the settings JSON). The channel-server injection is provider-specific: Claude's is inside the `--mcp-config` JSON, but the **Codex daemon** takes it as a literal `-c mcp_servers.autonomos.env.AUTONOMOS_AGENT_TOKEN="<hex>"` flag, so for Codex agents the token is in `/proc/<pid>/cmdline` — **world-readable on default Linux (`hidepid=0`)**, i.e. readable by *any* local user, not just the same-user set above. This is not a new class (the global `AUTONOMOS_TOKEN` has always ridden Codex argv the same way), but the doc claim is now narrowed to match reality. The server LOG is scrubbed either way (`redactArgForLog` redacts `AUTONOMOS_[AGENT_]TOKEN=` in the spawn + fast-crash re-log). A tighter fix — hand the Codex daemon the token via a real child-process env var instead of a `-c` flag — is a follow-up if the app-server inherits env into its MCP subprocess (unverified).
  3. **REST decouple + gemini fix + observability, folded in:** channel-server REST base is now an explicit `AUTONOMOS_API_URL` (public) injected by all three providers instead of string-derived from the WS URL (which breaks once the WS is a socket); `gemini-cli.ts`'s `process.env.PORT || "3000"` bug fixed by moving `writeGeminiSettings` to after the port+socket bind (its write-once shared settings file is why gemini alone carried that bug); `scheduleChannelServerCheck` hoisted out of the Codex-only `if (sidecar)` block so every socket-dialing agent gets outbound-launch-failure observability; and `buildBaseEnv` now calls `assertSpawnReady()` (checks both port and socket) so a boot-window spawn yields the typed retryable 503 regardless of which precondition is missing — the recommended line-swap alone was ineffective, proven by mutation test.
  4. **DEFERRED, not done:** **Layer 2 strong-token enforcement** (reject/warn on a weak operator-set `AUTONOMOS_TOKEN` — forge's is 5 chars) is not in this PR; it is the actual live exposure on forge (all-interfaces bind guarded only by that token) and wants its own change. **Delivery-ack semantics** ("ack means DELIVERED, not ROUTED") is deferred pending CodexGemini's idle-gate-removal PR (#287-adjacent), to avoid rebuilding the ack path underneath them. Both tracked as follow-ups.
  5. **Gemini outbound is a KNOWN PRE-EXISTING GAP — not a PR B regression (verified empirically against main).** Surfaced during the security review (AppSecurityAudit finding B): a real Gemini spawn showed its channel-server has neither `AUTONOMOS_AGENT_TOKEN` nor `AUTONOMOS_TOKEN` — Gemini filters MCP-subprocess env to an allowlist that excludes both. Spawning Gemini against **main** confirmed its channel-server there also never registers (it dials `ws://localhost:3000` — the pre-existing `process.env.PORT || "3000"` bug, wrong port — AND lacks the global token), so Gemini gateway/outbound has never worked (matches the "Gemini inbound = PTY-injection only" history). **The split is precise:** Gemini HOOK identity WORKS (the hook curl runs in Gemini's own shell env, which has the per-agent token — verified live: SessionStart → status `ready`); only the channel-server → gateway leg (outbound `send()` + org tools) is dead. **PR B improves this** — the hoisted `scheduleChannelServerCheck` now fires a dashboard `SystemWarning` per Gemini agent, so the gap is visible instead of silent. The real fix (a **per-session token file** keyed by session id — `SESSION_ID`/`CONFIG_DIR`/`INTERNAL_SOCKET` do propagate to Gemini's channel-server, so it could read the token from disk; a no-op for claude/codex which keep using env) is a follow-up, not PR B. Claude and Codex outbound identity are unaffected and verified working.
- **Update (2026-07-28, implementer — token-file follow-up, PR #297):** Consolidated per-agent-token DELIVERY to the channel-server onto a **per-session file**, removing the Codex argv exposure (item 4.2) and consolidating three per-provider delivery paths into one. Terry's call (option C). **IMPORTANT correction from real-spawn QA + AppSecurityAudit review: this does NOT fix Gemini outbound (item 5).** It fixes the token-*delivery* precondition for Gemini, but Gemini outbound stays dead for a deeper, separate reason (see item 5 below).
  1. **The mechanism.** `agentCredentials.ts` gains `writeAgentTokenFile(sessionId)` — mints (idempotent) and writes the token to `<configDir>/agent-tokens/<sessionId>`, mode `0600`, dir `0700`. `runtime.ts` calls it at spawn *before* the sidecar/PTY (the channel-server must be able to read it the moment it launches). `revokeAgentToken` now unlinks the file too (best-effort), so `markExited` leaves no stale secret on disk; `sweepAgentTokenFiles()` runs at boot before `resumeActiveAgents` to clear files a crash (no revoke) left behind — the respawn re-writes fresh ones, so the on-disk set matches reality (AppSec finding B). `agentTokenFilePath` runs `assertSafeSessionId` (rejects `/`, `..`, whitespace) because the id is attacker-influenceable on the resume/adopt path and lands as a path segment.
  2. **The channel-server reads the file** (`channel-server/index.ts`): derives the path from `AUTONOMOS_CONFIG_DIR` + `AUTONOMOS_SESSION_ID` — both non-secret names every provider propagates, unlike `AUTONOMOS_AGENT_TOKEN` — and falls back to the env var for a mixed-version window (an older server that still injected it). It re-validates `SESSION_ID` inline before using it as a path segment (AppSec finding A): a standalone bundled subprocess deriving a filesystem path from an env var shouldn't trust the value is well-formed just because the current caller happens to guard it — a bad value falls through to the env path instead of traversing.
  3. **All three providers drop the token env/argv injection.** Claude removes `AUTONOMOS_AGENT_TOKEN` from the `--mcp-config` env and adds `AUTONOMOS_CONFIG_DIR`; Codex removes the world-readable `-c ...AUTONOMOS_AGENT_TOKEN=` flag and adds a `-c ...AUTONOMOS_CONFIG_DIR=`; Gemini adds `AUTONOMOS_CONFIG_DIR` to its (shared, write-once) settings and relies on env passthrough for the per-process `AUTONOMOS_SESSION_ID`. `AUTONOMOS_CONFIG_DIR` is added to `RESERVED_ENV_KEYS` so a user `customEnvVar` can't repoint the token-file path. The **hook** path is unchanged — it keeps reading `${AUTONOMOS_AGENT_TOKEN}` from the agent's own env (a curl can't read a file without re-exposing the value in *its* argv; the hook env was never the leak).
  4. **Real-spawn QA (isolated server, definitive gateway-register log, not an absence signal):** Claude ✅ and Codex ✅ write a `0600` file AND **register on the gateway** — proving the file path e2e (Claude has no env-token fallback anymore, so a register can only come from the file). Codex argv leak structurally gone (no `AUTONOMOS_AGENT_TOKEN` in any `-c` line). **Gemini ❌ does NOT register** — and `ps` shows the Gemini process has NO `channel-server/dist.mjs` child at all: Gemini in autonomOS's `-i` PTY mode never launches the MCP channel-server subprocess, so token delivery is moot. An earlier "Gemini registers" claim in this PR was a FALSE POSITIVE from an absence-based signal (`status=running` + no never-registered warning); `status=running` comes from HOOKS, which work for Gemini regardless, so it did not prove the gateway register. AppSecurityAudit caught this in independent review.
  5. **Gemini outbound is STILL an open gap — reframed, not fixed.** The blocker is NOT token delivery (that now works) but that Gemini never launches the channel-server MCP subprocess in `-i` mode. This wiring makes the token *readable once that launch gap is fixed*; it is a precondition, not a working fix. Filed as a separate follow-up (Gemini MCP-launch in `-i` mode). Also observed: `scheduleChannelServerCheck`'s never-registered warning did NOT fire for the un-registered Gemini agent within its grace window, so the "gap is visible not silent" claim from PR B does not hold for Gemini — worth a look in the same follow-up.
  6. **Honest scope (unchanged):** same-user still reads env, argv, AND files — defense-in-depth + attribution, not a kernel wall. Concrete wins over the ADR-055 state: the Codex token is off world-readable `/proc/<pid>/cmdline`, the file is `0600` (other-user safe) + deleted on exit + swept at boot, and one mechanism replaces three. **Single-use / short-TTL was considered and dropped** — incompatible with the hook path, which needs the token valid for the agent's whole life. **delivery-ack** stays a separate surface, handed to TeamLead → CodexGemini. **Layer 2** stays parked (personal-device threat model).

## ADR-056: Resume any external Claude Code session — adopt-into-managed + unify id == providerSessionId
- **Date:** 2026-07-18 — **Decided by:** Human (Terry: "any agent we've spawned — in autonomOS OR outside — must be resumable inside autonomOS, via UI click AND via MCP"; approved adopt→managed + the id-unification), investigated + implemented by ExternalCCResume@autonomOS under TeamLead@autonomOS lead
- **Context:** A real user hit this during onboarding: Claude Code sessions started from a terminal (`claude`, outside autonomOS) appear in the dashboard Projects panel but clicking **resume** returned `failed to resume session`. Verified by three converging investigations + live server + code read: **discovery was never broken** — `GET /api/projects` lists external sessions via the CC SDK `listSessions()`. The break was entirely resume-side, and precisely dated: commit `9ac5d5b` — *"unify Agent + Session (#165)"*, 2026-05-04. That refactor deleted `routes/sessions.ts` (whose `POST /api/sessions` passed `resumeSessionId` straight to `claude --resume <id>`, no record required) and replaced it with the agent-record-gated `spawnAgent`, collapsing two distinct id-spaces — a raw CC session id vs. an internal autonomOS agent-record id — into one `resumeAgentId` resolved only by `getAgent()`. An external CC session has no record, so every entry point (UI external branch, `POST /api/agents`, `/attach`, and MCP `create_agent`) 404'd with `resumeAgentId "<uuid>" not found`. The regression was never recorded as a decision — silent drift. The same conflation also caused a chronic footgun for **managed** agents: resuming needed the autonomOS id, but the CC session id (what's visible / what the Projects panel keys on) was reached for first, 404'd, then retried.
- **Decision:**
  1. **Restore an external-resume path under a distinct name.** `spawnAgent` gains a first-class `resumeSessionId` (raw CC session id), kept separate from `resumeAgentId` (internal record id). It resolves the id against BOTH the agent store (by `providerSessionId`, new `getAgentByProviderSessionId` helper, or by agent id for migrated records) → reattach a managed record; and, on a miss, **adopts** the external session into a NEW persistent managed `Agent` record and resumes it. Adopt is gated on `provider.hasResumableSession`: a never-conversed external session with no JSONL on disk is rejected (`422`, "nothing to resume") rather than silently started fresh (a silent-failure class).
  2. **Adopt → managed** (Terry's call): the adopted session becomes a first-class managed agent (survives restart, appears in the org chart), not an ephemeral attach.
  3. **Unify `id == providerSessionId`** for all newly-spawned agents (fresh, fork, and adopt — adopt reuses the external CC id as the agent id). One id, so callers never have to guess which to pass on resume. Matches migrated (pre-#165) agents, which already satisfy this.
  4. **MCP + REST wiring:** `create_agent`'s `resumeSessionId` (both HTTP `mcp.ts` and channel-server handlers) now flows through as a raw id to the polymorphic resolver instead of being rewritten to `resumeAgentId`; `POST /api/agents` accepts `resumeSessionId`; `/attach` falls back to `getAgentByProviderSessionId` so **existing** split-id managed agents also resume cleanly from the Projects panel. The dashboard stops rewriting `resumeSessionId → resumeAgentId` and surfaces the server's error reason on failure.
  5. **Fail-closed guards on the adopt path** — every one rejects rather than producing a silent fresh session. Recorded here because three of them *modify behavior ADR-049 established*, and because a guard's placement turned out to matter more than its logic (each was individually correct and individually bypassable before review):
     - **Id validation.** The adopted id becomes the agent id and therefore the record's filename (`<agentsDir>/<id>.json`), so it is validated as a UUID before use — unvalidated, a `../`-bearing value writes outside the agents dir, on the same post-auth MCP surface ADR-054 hardened. `UUID` is a bare string alias, so this can only be a runtime check.
     - **Provider capability.** Adoption requires `hasResumableSession`. Codex and Gemini declare no probe AND their `buildArgs` ignore `resumeSessionId` (Codex resumes via `providerThreadId`), so adopting there would spawn a fresh session and report 201. The "Claude Code only" scope below is enforced by this guard, not merely documented.
     - **Probe failure fails CLOSED on adopt** — deliberately the inverse of ADR-049's fail-open. Fail-open is justified by "don't strand a real record with real history"; an adopt has no record yet, and a caller awaiting an HTTP response. Reattach keeps ADR-049's fail-open unchanged.
     - **The ADR-049 onExit safety net is vetoed for adopted records.** Its remedy (reset `providerSessionId`, respawn fresh) is right for a managed agent but leaves an adopted one healthy, named, and EMPTY — `--resume` then runs against the regenerated id and finds no transcript. Provenance is **persisted** as `Agent.adoptedExternal`, not inferred from the spawn: after the adopting spawn an adopted record is indistinguishable from a fresh one (both satisfy `id === providerSessionId`), so a spawn-local check would re-arm the net on the *next* resume and reintroduce the failure one retry later. Because the net is disarmed, the adopt-failure notification is the only signal, so it fires on any short-lived adopt exit — including `exitCode === 0` — rather than on `crashed` alone.
     - **Reattach spawns in the record's own working directory**, not the caller's, and re-validates it. A caller-supplied path (the MCP schema requires one, independent of the session id) previously sent the resume probe to the wrong project dir → false "not resumable" → fresh start over a real conversation; and a record whose directory has since been deleted (routine here — `wt-sync` removes merged worktrees) would reach the PTY spawn unchecked.
     - **A present-but-empty or non-string resume/fork id is rejected at `spawnAgent`**, not the REST route: the HTTP MCP handler calls `spawnAgent` directly, so a route-level guard left that entry point uncovered. Every truthiness-based dispatch downstream treats such a value as absent, which would answer a resume request with a new empty agent.
- **Rationale:** Keep `resumeAgentId` + `/attach` untouched — the ADR-049 dev-restart resume path is load-bearing and battle-tested, so folding it into one polymorphic param risks regressing what already works. Two names for two id-spaces is also the exact lesson of the #165 bug being fixed: distinct semantics deserve distinct names (a type checker can't catch a raw CC uuid masquerading as a record id). The provider's raw `--resume <uuid>` argv (`claude-code.ts`) and the lazy-JSONL `hasResumableSession` probe survived #165 intact — the fix reconnects the plumbing to them rather than rebuilding. Unifying `id == providerSessionId` is defense-in-depth: even without the resolver, a unified-id agent has only one id, so the "try CC id, 404, retry agent id" dance becomes impossible going forward. Existing split-id agents are handled by the `getAgentByProviderSessionId` fallback rather than an id migration (changing an agent's id would break `managerId` pointers, layout pane ids, and session references).
- **Alternatives considered:**
  - *One universal `resumeSessionId` that also replaces `resumeAgentId`/`/attach`* — rejected: needlessly risks the tested managed-restart path and re-conflates the id-spaces.
  - *Migrate existing split-id records to `id == providerSessionId`* — rejected: an id is referenced by managerId, layout panes, and persisted sessions; rewriting it is high-blast-radius. The resolver fallback covers them with zero migration.
  - *Adopt as an ephemeral attach (no persisted record)* — rejected per Terry: the whole value is that a discovered session becomes a managed agent (restart-safe, org-chart-visible).
  - *Silently start fresh when an adopt target has no JSONL* — rejected: the user explicitly asked to resume THAT session's content; a silent empty session is the exact silent-failure class. Hard-reject with a named error instead.
- **Scope note:** Claude Code only. Codex external-session resume is deferred — the Projects panel discovers sessions via the CC SDK `listSessions()`, which does not enumerate Codex threads; that needs a separate Codex discovery source first. Gemini is out (separate known bugs, TokenSecurityAudit's queue). ADR-055 is reserved for AppSecurityAudit's planned two-listener split.
- **Source:** autonomOS CC session, ExternalCCResume@autonomOS worker; propose-pause diagnosis + fix plan approved by Terry, who also requested the id-unification during implementation. Verified end-to-end with a real terminal-started `claude` session resumed through the dashboard + MCP.

## ADR-057: The prompt-delivery receipt is capability-gated, and queued Codex inbound warns at 5 minutes
- **Date:** 2026-07-24 — **Decided by:** Agent (CodexInboundFix@autonomOS worker + pr-review-toolkit code-reviewer flag, routed by CodexGemini@autonomOS to TeamLead@autonomOS as DECISIONS.md owner). Terry was not in the loop for this specific call; recording it here IS his convention.
- **Context:** Two silent-failure bugs found while investigating a report that a Codex agent had dropped an inbound message during forge QA.
  1. **A false alarm with a 100% false-positive rate.** `trackPromptDelivery` (`agents/promptDelivery.ts`) confirms a starting prompt was submitted by watching the HOOK RELAY for `SessionStart` → `UserPromptSubmit`. It was gated only on `if (params.prompt)` — no provider check. Codex declares `hooks: { eventCount: 0 }` (it derives status from its app-server event stream, ADR-046-era design), so its `SessionStart` can never arrive and the 15s timeout fired on **every prompted Codex agent**, logging "agent may have failed to boot" and pushing a dashboard `SystemWarning`. Reproduced on an agent that had already executed its prompt correctly. The re-delivery fallback was equally never reachable: it requires the `awaiting_prompt_submit` phase, which requires a `SessionStart`. So the mechanism had zero true-positive capability for Codex and cost InternalSocket@autonomOS real debugging time — the warning pointed the original diagnosis at the prompt path, which was not where the bug was.
  2. **A correct queue that said nothing.** Codex inbound is idle-gated (`gateway/codexControl.ts`) on the assumption — **untested at the time of writing** — that injecting a `turn/start` mid-turn interleaves and corrupts the thread, so messages queue until `thread/read` reports idle. The queueing behavior is not the bug here; the silence is — the wait emitted no output at all: no enqueue log, a 15-minute silent poll (`idleDeadlineMs`), and an operator notification only at 3 consecutive failures ≈ **45 minutes**. A working queue and a dropped message produced byte-identical logs, so a correctly-queued message was reported as lost.
- **Decision:**
  1. **The prompt-delivery receipt applies only to providers that emit hook events** — gated on the CAPABILITY `capabilities.hooks.eventCount > 0` via `supportsPromptDeliveryReceipt()`, never on a provider name. Claude Code (13 events) and Gemini (11, with `SessionStart`→`SessionStart` and `BeforeAgent`→`UserPromptSubmit` translation) keep it; Codex (0) does not.
  2. **Queued Codex inbound gets a one-shot operator notification at 5 minutes** (`queueWaitWarnMs`), replacing the 3×15-minute silence path. The 15-minute tolerance for legitimately long turns is unchanged — this decision does not revisit whether waiting is necessary (that rests on the untested assumption above); it fixes only the silence. The warning is per stall EPISODE (controller-scoped, cleared on successful injection), not per message: a per-message flag re-fires for every backlogged item the instant a stall ends, because each inherits an old `queuedAt` — a burst of "its current turn hasn't finished" at the exact moment delivery starts succeeding.
- **Rationale:** A capability check auto-corrects for providers that do not exist yet — Hermes (see `docs/research/`) or any future provider is classified by what it declares, with no code change and no chance of being forgotten. A provider-name allowlist is O(N) maintenance whose failure mode is silent and delayed: the miss shows up as a false warning on a provider added months later, which is precisely the bug being fixed here. On the notification threshold: 5 minutes is far longer than any healthy idle-gated wait and far shorter than the 45 minutes it replaced, and it is the ONLY signal that separates "queued behind a wedged turn" from "delivered" — the dashboard shows `working` either way.
- **Alternatives considered:**
  - *Provider-name allowlist (`if (provider !== "codex")`)* — rejected: O(N) maintenance, and it silently mis-classifies any new provider until someone notices a false warning.
  - *Leave the receipt on for Codex and just soften the warning text* — rejected: the check can never succeed, so any wording is still a guaranteed false positive.
  - *Drop the tracking and add no queue signal* — rejected: that trades a false-warning bug for a silent-drop bug, which is strictly worse (the false warning is at least visible).
  - *A Codex-native detector via `thread/status` polling* — deliberately NOT this ADR. It is scoped as a follow-up: it would not have caught the failure that triggered this investigation (a turn that starts and never finishes), and a new detector is new behavior deserving its own review and QA rather than riding a reviewed PR.
- **Consequence — recorded explicitly:** **Codex spawn-with-prompt now has NO delivery detector.** If the `--remote` TUI fails to attach, the prompt is lost AND the daemon reports the thread idle — so "never started" is indistinguishable from "finished." A Codex-native detector via `thread/status` (which `statusLoop` already polls) is a scoped follow-up. This is documented at the `runtime.ts` call site and in `CLAUDE.md` so it is not rediscovered as a bug.
- **Related:** the same PR fixes four genuine silent drops in the delivery path (teardown clearing the queue with no log — the module's only true message drop; the broadcast fan-out skipping endpoint-less Codex agents; unicast falling through to a channel-server socket whose reader discards inbound; and an uncaught broadcast promise chain), plus a status reconciler whose escalation could never fire because read failures were swallowed. Those are bug fixes against existing intent, not new policy, so they are not separate decisions.
- **Source:** PR #287 (`terry/codex-inbound-fix`), CodexGemini@autonomOS Codex IAC initiative. Bug reported by InternalSocket@autonomOS during forge QA; investigation refuted all three initial hypotheses (status-field overwrite, lost sidecar endpoint, `--remote` ignoring the positional prompt) with live evidence. The 5-minute policy and the capability gate were approved by CodexGemini@autonomOS before implementation; the ADR was routed to and cleared by TeamLead@autonomOS.

---

## ADR-058: Deprecate agent `capabilities` — a tool-visibility filter that restricted nothing and misinformed the agent

- **Date:** 2026-07-24 — **Decided by:** Human (Terry: "just do 1 PR, let's do it" — approved the one-PR clean removal over a phased deprecation), investigated by InternalSocket@autonomOS, independently re-verified and implemented by CapabilitiesDeprecate@autonomOS under TeamLead@autonomOS lead
- **Context:** Terry spawned a `feature-worker` on forge and found `create_agent`/`kill_agent`/`self_exit` absent from its tool list while `send`/`list_agents`/org-chart/template/schedule tools were present. Root cause: that host's `~/.autonomos/templates/feature-worker.json` declared `capabilities: ['send','list_agents']`, and the channel server honored it by filtering tool registration. The feature's original intent was cost control — stopping a worker from recursively spawning a fleet. Two properties, both verified before the decision, made it net-negative:
  1. **It was not a security boundary.** Gating happened only in the MCP layer (`filterToolsByCapabilities` at list time, plus a call-time rejection in `channel-server/index.ts`). `routes/agents.ts` contained zero references to capabilities: `POST /api/agents` is capability-blind and authenticates on the same bearer token every agent already holds in its own PTY environment. Verified empirically from inside a running restricted-shaped agent — `AUTONOMOS_TOKEN` present in env, `GET /api/templates` returning 200 with it and 401 without. Any agent denied `create_agent` could spawn agents with one `curl`.
  2. **It actively misinformed the agent.** `providers/shared.ts` interpolates the full, unfiltered `MCP_INSTRUCTIONS` into `BASE_CONTEXT`, injected into every session via `--append-system-prompt`; `channel-server/index.ts` passes the same unfiltered text as the MCP server's `instructions`. Only the tool *registrations* were filtered. A restricted agent was therefore told in its own system prompt that it had tools it could not call, and could not distinguish "I lack permission" from "the server is broken." That ambiguity is what cost Terry debugging time.

  A third finding confirmed the field had rotted from disuse: **four mutually inconsistent definitions of the default set** existed simultaneously — `DEFAULT_CAPABILITIES` (all 5), the `POST /api/templates` fallback (4, no `self_exit`), the dashboard's `ALL_CAPABILITIES` (4, no `self_exit`), and the seeded `feature-worker` (3). The dashboard UI could not grant `self_exit` at all, so any template created through the panel produced an agent unable to terminate itself. Nothing tested the field end-to-end, so nothing caught the drift.
- **Decision:** Remove the feature entirely in one PR rather than deprecating in phases.
  1. **Delete the gating** — `DEFAULT_CAPABILITIES`, `CAPABILITY_GATED_TOOLS`, and `filterToolsByCapabilities` in `mcp/tools.ts`; the `AUTONOMOS_CAPABILITIES` env read, the list filter, and the call-time rejection in `channel-server/index.ts`; the env injection in the Claude Code and Codex providers; `ResolvedSpawnOptions.capabilities` and its resolution in `agents/runtime.ts`; the field is no longer written by `create_template` (both MCP transports) or `POST /api/templates`.
     **Write paths report the field instead of dropping it.** `capabilities` is retained on both `create_template` schemas *solely* as a deprecation marker (described as "DEPRECATED — ignored"), and the REST route returns a `warnings` array when a body carries it. This is deliberate and was not in the original plan: every agent spawned before this ADR still holds the OLD tool schema in its conversation context and will keep sending `capabilities` for as long as it runs. Zod strips unknown keys, so without an explicit declaration the field vanishes and the agent is told `ok: true` — leaving it believing it restricted a worker, with no way to discover otherwise. Silently accepting a control request you do not honor is the same class of defect as the original feature. Both markers are removable once no pre-ADR-058 agent is running.
  2. **`AgentTemplate.capabilities` is removed from the type**, and `getTemplate()` gains an accept-and-discard block mirroring the ADR-045 `autonomousMode` migration: an on-disk `capabilities` field loads without error, is scrubbed before reaching consumers, and emits **one** notice per template name per process (`getTemplate()` runs on every spawn; an unguarded warn would fill the rotating log with a line the operator cannot act on). Old templates keep working — never reject, never crash.
  3. **The cost-control intent moves to the system prompt.** The seeded `feature-worker` template now states, in prose, not to spawn peers via `create_agent` or terminate others via `kill_agent`, and to exit via `self_exit` or wait for its manager — *with the reason* (recursive spawning multiplies cost; nobody is tracking the resulting fleet). `dispatcher` and `team-lead` are orchestrators and are deliberately unconstrained.
  4. **The dashboard capability checkboxes are removed**, and the template card's freed footer slot now shows `permissionMode` — the attribute that actually governs agent behavior.
  5. **`ALL_TOOLS` is now documented as required to match `MCP_INSTRUCTIONS`**, since the instructions are injected verbatim into every agent's system prompt. Restoring any filter without also filtering the instructions would recreate exactly the failure this ADR removes.
- **Rationale:** A control that is bypassable *and* misleading is worse than no control: it provides no enforcement while actively degrading the agent's model of its own environment, and it consumed operator debugging time. Enforcement was always zero — a hostile agent bypasses prose and tool-hiding identically, because both reduce to "the token is in the environment." What changes is comprehension: a cooperative agent complies with a stated constraint it understands, whereas a missing tool is ambiguous evidence it must guess about. So the honest instrument is the one that explains itself. Prose also cannot drift out of sync with reality the way a second, unfiltered tool list did. Removing the type field rather than keeping a deprecated no-op keeps the dashboard from displaying checkboxes that do nothing — the same "declared but not implemented" pattern being deleted. Backward compatibility is cheap here because the loader is plain `JSON.parse` with no schema validation, so unknown fields already survive; the explicit scrub plus a one-time notice makes the ignore visible rather than silent.
- **Alternatives considered:**
  - *Make capabilities a real security boundary* (per-agent scoped tokens, capability checks on the REST routes) — rejected as out of scope: it is a different feature requiring per-agent credential issuance and Terry's design input, and the containment question is already on AppSecurityAudit's queue. Deprecating the fake boundary does not foreclose building a real one.
  - *Two-phase deprecation* (Phase 1: stop filtering, keep type + UI + docs with a "(deprecated)" label; Phase 2: remove later) — rejected by Terry. Phase 1 leaves visible checkboxes that change nothing, perpetuating the exact pattern the change exists to end, and the removal diff is small and mechanical enough that splitting adds ceremony without reducing risk.
  - *Fix the drift instead* (align the four default sets, add `self_exit` to the UI, filter `MCP_INSTRUCTIONS` to match the registered tools) — rejected: it would make the feature coherent but still unenforceable, so it buys consistency in a mechanism that provides no guarantee, at permanent maintenance cost.
  - *Keep `capabilities?: string[]` on the type as a deprecated no-op* — rejected: a field present in the type invites new writers and keeps the UI plausible. The runtime scrub covers on-disk compatibility without the type advertising a knob.
- **Collateral hardening (same load path, pre-existing):** reviewing this change surfaced four defects in `getTemplate()` and its callers, fixed here because the deprecation adds a second mutation block to the very function whose throws escaped.
  - **`resumeActiveAgents()` called `getTemplate()` outside its per-agent `try`.** `getTemplate` throws on anything that isn't ENOENT, so one corrupt template rejected the whole function; the caller only `.catch()`es it to a log line. Every agent after the bad one kept `status: "running"` with no PTY behind it — a dashboard of green agents whose terminals are dead, never `markExited`, never notified. The function's own docstring promised per-agent recovery; this line bypassed it. Reproduced and fixed on an isolated server with a truncated template.
  - **A template file containing a JSON array loaded as valid.** Arrays are objects, so every `in` check no-opped, and callers test only truthiness — `[]` is truthy — so a list-wrapped write spawned an agent with no role and no permission mode, silently. Now rejected by a shape guard whose message names the file rather than an internal field name.
  - **An invalid `permissionMode` was discarded without notice when a legacy `autonomousMode` was also present** (the notice sat in an `else` of the migration), so the log said "migrated legacy autonomousMode" and pointed away from the real cause.
  - **Load-time notices were unthrottled.** `getTemplate()` runs on every spawn *and* every `GET /api/templates`, which the dashboard polls every 10s — roughly 6 lines/minute forever from a single legacy template. All notices now route through one warn-once helper keyed by *file version* rather than name: the operator's job after a notice is to edit that file, so silence must mean "fixed", not "already told you about a version that no longer exists".
- **Rollout note:** `seedDefaultTemplates()` returns early when the templates directory is non-empty, so the new `feature-worker` prose reaches **fresh installs only**. Existing hosts keep their on-disk `systemPrompt` while their agents gain the full tool set — the deprecation is safe for loading but does not deliver its own replacement. The load-time notice (which names the file path) is the bridge; updating an existing worker template is a manual, one-line edit. Deliberately not auto-migrated: silently rewriting an operator's `systemPrompt` would be a worse failure than the one being fixed.
- **Implementation note:** `packages/server/src/channel-server/dist.mjs` is a **tracked, committed esbuild artifact**, and `scriptPaths.ts` points `CHANNEL_SERVER_SCRIPT` at `dist.mjs` — not `index.ts` — in dev-from-source as well as bundled builds. Editing the source alone changes nothing at runtime. Its only build step is inline in the Makefile `prod` target, so the bundle must be rebuilt and committed alongside any channel-server change.
- **Source:** autonomOS CC session. Symptom reported by Terry from forge; root-caused by InternalSocket@autonomOS; independently re-verified (empirical token/API probe, injection-path read, four-way drift discovery) and implemented by CapabilitiesDeprecate@autonomOS. One-PR approach approved by Terry on 2026-07-24. Numbering note: ADR-055 is reserved for AppSecurityAudit's two-listener split and ADR-057 was claimed by PR #287 while this work was in propose-pause.

## ADR-059: Remove the markdown file preview feature (supersedes ADR-018)
- **Date:** 2026-07-25 — **Decided by:** Human (Terry: *"clicking a markdown file local link opens a window/tab that previews the markdown file — this feature has been broken for a long time, remove it completely"*; also approved deleting the file API), investigated + implemented by MarkdownPreviewRemove@autonomOS under TeamLead@autonomOS lead
- **Context:** ADR-018 shipped a three-layer markdown preview in #30 (`d3cf9b0` → `7a709ed`, 2026-03-14): a `MarkdownLinkProvider` xterm link provider detecting `.md` paths, an in-dock `PreviewPane`, a standalone `/preview?file=` route, and `GET /api/files/read` + `WS /ws/files/watch`. Empirical audit on an isolated instance found the feature **not dead but behaviorally regressed** — the server API returned correct content (200 / 403 outside `$HOME` / 401 unauthenticated), the renderer rendered, and the detection regex matched 8/8 realistic Claude Code output forms. What broke was pane management, in two silent steps:
  1. **#263 (`0998a6d`) made dockview the default layout engine.** Every other `open*` store action received an explicit dockview branch (`if (layoutEngine === "dockview") { switchPane(...); return; }`); `openPreview` was the only one that did not. Under dockview it therefore set `activePane` alone → `DockviewLayout`'s `syncToActive` found no bound workspace for the fresh preview id → `showSolo()` → `for (const panel of [...api.panels]) api.removePanel(panel)`. Reproduced live: a dock showing "Schedules" plus `openPreview()` leaves **only** the preview. In practice, ctrl+clicking a `.md` in an agent's terminal destroys the terminal pane. This directly reverses #103 (`a80db6b`), which had shipped "openPreview adds as new tab instead of replacing". #266 (`a2815cb`) then deleted the dead legacy `addTab` line, codifying the solo behavior as intentional.
  2. **#249 (`8a0257a`) made the sidebar default to hierarchy view.** Preview rows are built only in the flat path; the hierarchy path renders sessions only. On the default view an open preview therefore had no sidebar row at all — unreachable and uncloseable except via its dock tab.
  Both regressions landed green because **the feature had zero test coverage** — no test referenced `MarkdownLinkProvider`, `PreviewPane`, `PreviewPage`, `openPreview`, or either file route, and no e2e spec touched preview. (`hooks/linkProviders.test.ts` resembles coverage but hand-copies the URL regex and exercises only `UrlLinkProvider`.) A contributing mechanism for a pure "click does nothing" report was also confirmed at the xterm level: xterm registers its internal `OscLinkProvider` during core setup and `registerLinkProvider` **pushes**, so OSC 8 hyperlinks are matched before any user-registered provider.
- **Decision:** Remove the feature completely, in one PR, including the server file API.
  1. **Delete** `components/PreviewPane.tsx`, `PreviewPage.tsx`, and `routes/files.ts` (the `/preview` path in `main.tsx` collapses to `<App/>`).
  2. **Delete `GET /api/files/read` and `WS /ws/files/watch`.** ADR-018 justified the endpoint partly as "a general file API"; it acquired no other consumer in four months. Terry approved deletion explicitly.
  3. **Remove the `"preview"` member of the `ActivePane` union**, the `previewPanes` state + `openPreview`/`closePreview` actions, `PreviewPaneInfo`, `previewOrderKey`, and the preview arm of every layout/sidebar consumer. `buildFlatSections` drops to 3 params and `paneFromId` to 1. `SidebarItem` (`{type, data}`) is **deleted** rather than left as a single-member union: with the preview arm gone nothing reads its discriminant, `sidebarItemKey` became an exact duplicate of `sessionOrderKey` (now exported), and `sidebarItemPane` became the same `{type:"session", id}` literal the hierarchy path already inlines. The flat-view helpers operate on `SessionInfo` directly; `Sidebar`'s parallel `DisplayItem` wrapper is deleted with it.
  4. **Tighten `isValidActivePane` to reject `{type:"preview"}`** — load-bearing, see backward-compat.
  5. **Drop 5 now-unused dependencies**: `react-markdown`, `remark-gfm`, `mermaid`, `dompurify`, `@types/dompurify`; and the `markdown`, `copy`, `link-external` codicons orphaned by the deleted toolbar. Also delete the `.prose-custom` typography block, surgically preserving the `.overflow-y-auto` half of the scrollbar selectors it shared.
- **Backward-compat (persisted state):** There is no zustand `version`/`migrate` hook — all schema handling lives in the hand-rolled `merge` — and a version bump was rejected because it would reset every user's entire layout to fix one nullable field. The important finding, surfaced by the silent-failure review and **missed by the first implementation**, is that a pane descriptor has **two** persisted carriers, not one; guarding only the obvious one leaves a bypass (the same lesson as ADR-056's guard-placement notes):
  1. **`activePane`** — now **rejected by `isValidActivePane`**, degrading to `activePane: null` (the friendly empty state). Unguarded it would restore cleanly, reach `PaneContent`, match no case, and hit `default: return null` — a silently blank pane.
  2. **`dvWorkspaces[*].serialized`** — dockview's `toJSON()` serializes every panel's `params`, so `params.pane = {type:"preview"}` survives inside the workspace blob and is re-created verbatim by `fromJSON` on restore. `merge` validates only that `serialized` is a non-null object, so this carrier is **unvalidated by design**. It produced an empty pane under a tab literally titled "Tab". The dead-panel strip in `DockviewLayout` does not save it: that strip is gated on `sessionsInitialFetchDone`, which never flips while `/api/agents` is failing (`fetchSessions` early-returns on a bad response), so the blank tab was **permanent** for such a session. TypeScript offers no help either — deleting `"preview"` from the union makes the branch look unreachable to the compiler while it stays live at runtime against untyped JSON.
  Both are closed at the **narrowest shared boundary** rather than per-path: `PaneContent` is where every panel path (`fromJSON`, `showSolo`, `addPanel`, drop) converges, so an unrenderable pane type is closed there with a `console.warn` naming the panel and type. `StatusTab` reports `Unknown (<type>)` instead of `"Tab"` so the transient state is diagnosable.
  A related bypass was closed with it: `paneFromId` classifies every non-singleton id as a session, so activating such a panel would have written back `{type:"session", id:"preview-…"}` — a shape that *passes* `isValidActivePane` on the next reload, laundering a retired pane into a terminal dialing `/ws/terminal/` for a session that never existed. The new `paneFromPanel` trusts a panel's own descriptor and skips the writeback when it is invalid. Both guards have regression tests.
  The remaining stale state is inert and self-heals:
  - `previewPanes` disappears from localStorage on the first persisted write, because zustand's persist replaces the whole blob with `partialize`'s output.
  - Leftover `preview:*` keys in `pinnedOrder`/`unpinnedOrder` are swept by `fetchSessions`' prune once `keepKey`'s `startsWith("preview:")` escape hatch is removed. Note this is *opportunistic*, not a guaranteed migration: the prune is gated on the session list changing, so a zero-agent user can keep the keys indefinitely. Harmless — `buildFlatSections` skips keys with no matching live item (covered by an existing test).
  - `reconcileDeadWorkspaces` drops preview ids from `dvWorkspaces[*].paneIds` and `dvPaneWorkspace` (they are neither singletons nor live sessions). It deliberately does **not** rewrite `serialized` — that blob is swept by `syncToActive`'s dead-panel strip on the next restore, which is exactly why carrier 2 above needed its own guard.
  - `/preview?file=…` URLs keep resolving (the production SPA fallback) and simply render the normal dashboard; a hard 404 was deliberately not added. Stale un-reloaded tabs calling `GET /api/files/read` get an honest JSON 404, because the `/api/*` catch-all is registered before the SPA fallback.
- **Rationale:** Fixing it would mean giving `openPreview` its dockview branch, adding preview rows to the hierarchy sidebar, and resolving the OSC 8 precedence question — then writing the test coverage whose absence let it rot twice in silence. That is a feature rebuild, not a repair, for a capability Terry does not want. Removing it also eliminates 100% of the dashboard's `dangerouslySetInnerHTML` surface (the only two call sites were the duplicated `MermaidBlock` components) and drops a large `mermaid` bundle.
- **Alternatives considered:**
  - *Fix the regressions* — rejected by Terry; the feature is unwanted, and the repair is a rebuild.
  - *Keep the code, unwire the trigger* — rejected: leaves an unreferenced renderer, 5 dependencies, and a persisted pane type to rot further. The audit brief explicitly called for no orphaned code.
  - *Keep `/api/files/read` for the future F-011 File Browser* — rejected by Terry. F-011 is a P2 Concept that would want a purpose-built endpoint; a consumer-less endpoint that reads any file under `$HOME` is the worse default.
  - *Phase the removal* — rejected: the `ActivePane` union and the `paneFromId`/`buildFlatSections` signatures cannot be half-removed without leaving the type system worse than either endpoint.
- **Consequences:** Users lose in-dashboard markdown preview and must open `.md` files externally (editor, browser). Any bookmarked `/preview?file=…` link now renders the dashboard instead of the file. If a working version is wanted later, ADR-018's "split pane in SessionPane" alternative plus real test coverage is the starting point — not a revert.
- **Source:** autonomOS CC session, MarkdownPreviewRemove@autonomOS worker; propose-pause audit (isolated instance on ports 3199/5199, headless Chrome driving the real store) reported to TeamLead@autonomOS, full removal + API deletion approved by Terry.

---

## ADR-060: Remove the Codex idle gate — it duplicated a guarantee Codex already makes, and it deadlocked `wait_agent`

- **Date:** 2026-07-28 — **Decided by:** Agent (CodexGemini@autonomOS, on measured evidence gathered by CodexGemini@autonomOS and root-cause work by InternalSocket@autonomOS), implemented by CodexInboundTest@autonomOS. Terry authorized the phase and QA'd the running build.
- **Reverses:** the idle-gate assumption in **ADR-057**. That entry recorded the gate as resting on a belief "**untested at the time of writing**" — that a `turn/start` delivered mid-turn would interleave and corrupt the thread. It has now been tested, and it is false. ADR-057's *other* decision (capability-gating the prompt-delivery receipt) stands unchanged.
- **Context:** `gateway/codexControl.ts` queued every inbound message and injected only during a confirmed-idle window, polling `thread/read` before each delivery. The assumption was never measured. Two consequences followed:
  1. **It duplicated a guarantee Codex already makes.** Codex's own `followup_task` contract delivers a queued message at a message boundary while sampling, or after the pending tool call completes. Codex owns mid-turn delivery safety; our gate re-implemented it from outside, with strictly less information.
  2. **It created a deadlock.** A thread blocked in `collaboration.wait_agent` reports `active`. The gate therefore queued rather than injected — withholding the very message that would have released the agent. The agent waited on a message the gate was holding because the agent was waiting.
- **Decision:** `deliverToCodex` → enqueue → drain → `turn/start` **immediately**, into a busy thread. Deleted: `waitForIdle`, `idleDeadlineMs`, `queueWaitWarnMs`, `noteLongWait`, the per-controller long-wait flag, and `QueuedInbound.queuedAt`. Net deletion.

  **Explicitly KEPT, so nobody reads this as "the queue died":**
  - **(a) A best-effort skip while the last observed status is `"compacting"`.** This is **untested conservatism, NOT a measured requirement — we determined nothing about compaction, not that it's unsafe.** It reads the status feed already maintained for the dashboard rather than adding a gate of its own (one refresh only when the status is unknown). It does **not** guarantee we never inject during compaction, and that is deliberate: the value it reads is a cache, so it is cleared when its socket dies and the hold is bounded at 5 minutes, after which delivery proceeds and the operator is told the status looked stale. An unbounded hold on a cached value would be a silent drop with extra steps — reintroducing the #287 class through a new door, which review caught before this landed.
  - **(b) The queue as a retry buffer for genuine TRANSPORT failures** — socket down, no thread yet (a `--remote` TUI that never attached), a turn the daemon refuses — together with all of #287's logging on those paths. It buffers and retries; it never drops.
  - **(c) `thread/read` for dashboard STATUS only.** It is no longer a delivery gate.
- **Rationale — the asymmetry principle:** **keep cheap conservatism against severe unknowns; delete expensive conservatism against measured harms — evidence bars are weighted by cost, not applied uniformly.** The idle gate was expensive conservatism (it deadlocked agents) against a harm that measurement refuted, so it goes. The compacting skip is cheap conservatism (a bounded, self-ending hold that fails open, no extra I/O) against an unknown we did not probe, so it stays. Demanding the same evidence for both would be a false consistency: the cost of being wrong differs by orders of magnitude in each direction.
- **Evidence — 5 conditions, 8 injections, 1 control, all clean.** A `turn/start` into a BUSY thread is accepted and safe: the interrupted work completes, its result reaches the model, the thread stays intact (rollout diff = clean structural superset vs control), and the injected message is answered.

  | condition | result |
  |---|---|
  | blocked in `collaboration.wait_agent` | injected, agent released, thread intact |
  | backgrounded shell command | injected, work completed |
  | mid-reasoning | injected, answered |
  | synchronous non-backgroundable blocking MCP call (+ control) | injected, tool call completed, control matched |
  | `apply_patch` writing 12 files, injected at 3/12 and 10/12 | all 12 files byte-correct |

  **Live re-verification on the shipped build** (isolated dev server, real `codex` 0.144.6): an agent blocked in `wait_agent` was released ~4s after injection with zero stall lines; an 8-step task injected at step 3 finished all 8 steps byte-correct AND answered the injected message, with the daemon independently reporting `status=active` at the moment of injection; the thread's rollout parsed clean (74 lines, 0 invalid JSON).

  **UNTESTED — recorded so the gaps are not mistaken for coverage:**
  - **compaction** (hence the skip above)
  - **item-payload byte equality** — the rollout diff was structural, not byte-for-byte on item payloads
  - **version skew** — measured on local `codex-cli` 0.144.6; forge runs 0.145.0
  - **sample size** — the 8 injections came from 2 full measurement runs against a single model; conditions were not independently replicated
- **Methodology note (this cost real time):** **Codex BACKGROUNDS long shell commands, so `sleep N` never holds a turn open.** A test that shells out to sleep measures nothing — the turn ends immediately and the injection lands on an idle thread, silently passing for the wrong reason. Use an **MCP call as the turn-holding instrument** instead; it blocks the turn synchronously.
- **Alternatives considered and REJECTED — do not resurrect:**
  - *Suppress `multi_agent`* — removes a working capability to avoid a bug in our own gate.
  - *A `BASE_CONTEXT` "don't use `wait_agent`"* — trains agents off a working feature to preserve our workaround.
  - *Try-then-fallback on `ActiveTurnNotSteerable`* — **not reproducible**: that error never fired for `turn/start` in 8 attempts. Building a fallback for an error we could not produce is speculation, not defense.
  - *Classify busy-vs-waiting before injecting* — **provably impossible from our position.** The gateway is a NON-creator of the thread, and `thread/read` is byte-identical for a thread doing work and a thread blocked in `wait_agent`. There is no signal to branch on.
- **Consequences:** Inbound to a busy Codex agent now lands during its turn rather than after it, which is the intended behavior and matches Claude Code channels. The `wait_agent` deadlock is gone. Operators lose the "queued for N minutes" notification — it described a wait that no longer happens; the transport-failure notifications that actually indicate a problem are unchanged. Three unit tests that asserted the gate's mechanics were deleted rather than rewritten (they described behavior that no longer exists); the invariant-level integration suite from #292 held across the removal with **not one assertion moved** — the only edit was dropping `idlePollMs` from its timings call, since that timing no longer exists. That is the regression evidence for this change.
- **Related, same PR:** `shutdownAllAttachments` now calls `disposeCodexControl` on the shutdown PATH (not at process exit), so a restart mid-queue no longer discards buffered inbound without a trace. Verified by a controlled before/after: identical steps produced no output on the pre-change build and `DROPPING 1 undelivered inbound message(s)` after. **The durable half is the LOG only** — `dispose()` also pushes an operator notification, but that lands in an in-memory store the process destroys microseconds later at `process.exit`, so the dashboard never sees it. Recorded rather than papered over: the operator finds this in `$configDir/logs/autonomos.log`, not the notification panel. Making the restart drop *recoverable* (persisting queued inbound alongside the agent record and re-enqueueing on resume) is the real fix and is deliberately not attempted here. Also fixed: the control-socket error log printed an empty cause, because an undici `ErrorEvent` carries `message: ""` and `??` does not rescue an empty string — the one line naming a dead daemon named nothing.
- **Credit:** **InternalSocket@autonomOS** root-caused the deadlock by reading the Codex rollout file — the evidence that turned this from a theory into a measurement — and raised the asymmetry challenge that produced the evidence-bar principle recorded above.
- **Source:** autonomOS CC session, Codex IAC initiative. Measurement by CodexGemini@autonomOS; root cause and asymmetry challenge by InternalSocket@autonomOS; implementation, live QA and this entry by CodexInboundTest@autonomOS.

## ADR-061: Permission mode — the record follows the process, and `default` is renamed `ask`

- **Date:** 2026-07-28 — **Decided by:** Agent (PermissionModeRefactor@autonomOS). Terry reported the bug, asked for a full refactor of the surface, and chose the resume semantics, the readback scope, and the single-PR packaging.
- **Builds on:** **ADR-045** (per-provider permission modes replacing `autonomousMode`), whose 2026-06-26 update flipped `DEFAULT_PERMISSION_MODE` from `bypass` to fail-closed. Nothing in ADR-045 is reversed.
- **Context — the report:** a user saw the dashboard's permission setting on **Bypass** while Claude Code agents kept coming up ask-per-tool. One agent restarted another "as bypass"; the readback still showed the old mode, so they restarted again. Double-restart cycles. Terry additionally asked whether `restart-all` silently elevates every agent — a security question answered below.

  Investigation found **three separate defects**. Only the first explains the symptom; the other two are why nobody could see it.

  1. **The spawn/record divergence (the actual bug).** `spawnAgent` builds provider argv from `resolved`, which is spread from the caller's **params** (`runtime.ts`). The reattach persist went through `markRunning`, whose patch type was `Pick<Agent, "provider" | "providerSessionId" | "startedAt" | "providerThreadId">` — **structurally incapable of writing a `permissionMode`**. So `create_agent(resumeSessionId: B, permissionMode: "bypass")` on a record holding the ask-mode launched a PTY with `--dangerously-skip-permissions` while the record, the API, the dashboard, and every audit surface kept reporting the old mode, for the life of that process. Reachable by any agent through the channel server.

     It was invisible from any single layer: the argv was right, the record was internally consistent, and the next record-driven respawn quietly put the agent **back**, so the mismatch healed itself in the safe direction. Only comparing two layers reveals it.
  2. **No readback.** `permissionMode` was on the wire (`GET /api/agents` returns raw `Agent` records; there is no serializer) but dropped by every consumer: the dashboard's `SessionInfo` had no such field and the `Agent → SessionInfo` map discarded it, so **no per-agent permission display existed anywhere in the dashboard**; the channel server's `list_agents` — the only fleet view a spawned agent has — rendered `name (uri) — status`; and the `/api/agents/tree` serializer omitted it. The HTTP MCP server's `list_agents` *did* include it, so the two transports disagreed.
  3. **The name collision.** The enum value `"default"` collided with the ordinary word. The MCP schema every agent reads said **"Default: default — set 'bypass' for fully autonomous"**, which does not parse. The dashboard had already relabeled the option to **"Ask"** in #265, so the value and its own label had disagreed since then. Compounding it, there is **no server-side default-permission setting at all** — `settings.ts` has no such field. What looks like a global setting is a **browser-local localStorage value** that applies only to dashboard-initiated spawns; MCP and REST spawns resolve `args ?? template ?? DEFAULT_PERMISSION_MODE`. That is how "settings says Bypass" and "agents come up ask-mode" were both true at once.
- **Decision:**
  1. **The record follows the process.** `markRunning`'s patch accepts `permissionMode`, and the reattach persist writes the resolved mode. **The caller's explicit mode wins** — an explicit mode on a resume is an intentional instruction, and discarding it would be its own silent failure. This grants **no new capability**: `create_agent(permissionMode: "bypass")` is already permitted on a fresh spawn, so honouring it on a resume adds nothing; what changes is that the record stops lying.
  2. **One resolution point, placed AFTER the agent is resolved.** `params.permissionMode ?? agent.permissionMode` is computed **once** in `spawnAgent`, and the argv and the write-back both read that one value. Previously the record and the argv defaulted independently and agreed only because both happened to name the same constant. `DEFAULT_PERMISSION_MODE` backs only the record-minting path (`newRecordPermissionMode`, used by fresh/fork/adopt where there is no prior record). The placement is the point — see (6); resolving `?? DEFAULT_PERMISSION_MODE` up front is precisely the pre-collapse that silently demoted resumed agents.
  3. **Rename the value `"default"` → `"ask"`,** matching the label users already see and freeing the ordinary word for policy prose. `PERMISSION_MODES` is the canonical list and `PermissionMode` derives from it, so both Zod schemas pick a new value up automatically. Scoped honestly: that is *propagation*, not enforcement. A fifth mode compile-errors only where a mode is exhaustively keyed (`PERMISSION_MODE_INFO`); the three provider mappers end in `default:` catch-alls and would silently give it ask-equivalent behavior, and `mcp/tools.ts` keeps a hand-copy guarded by a test rather than the compiler.
  4. **Migrate on load, not passthrough.** `permissionModeFromStored` normalizes the legacy spelling at every persisted boundary — agent records, templates, dashboard localStorage.
  5. **Readback at the data layer only** (Terry's scope call): `SessionInfo` + both maps, `AgentInfo` + the channel server's `list_agents` line, and the tree serializer. **No new rendered dashboard surface** in this PR.
  6. **On a resume, only an EXPLICIT mode may change an agent's autonomy.** Callers forward `undefined` instead of pre-resolving it, and a template's mode is passed separately (`templatePermissionMode`) so it ranks BELOW the record on a reattach — matching `respawnAgent`, which reads `tmpl?.systemPrompt` but pointedly not `tmpl?.permissionMode`. Any change that does occur is logged.
- **`restart-all` does NOT elevate — the security question, answered.** `restartAllAttachments` re-reads each agent with `getAgent(id)` and calls `respawnAgent(a)`, which passes `a.permissionMode` — that agent's **own record**. No global is consulted. `restart-all` and `/attach` both send **no request body**, so defect (1) is unreachable from either. Verified across the three `respawnAgent` callers (startup restore, restart-all, the ADR-049 crash net) plus `/attach`, which passes `agent.permissionMode` directly. A deliberately-stricter agent stays stricter.

  This was true before this PR and is now pinned by an integration test that POSTs `/api/agents/restart-all` against a live mixed fleet and checks both the records and the respawned argv. Stated precisely because the first attempt at this test did NOT pin it: it looped `markRunning` with each record's own mode, which reimplements the caller under test and stays green even if `respawnAgent` starts consulting a global. That weaker test is kept, renamed to what it actually covers.
- **Caught in review, recorded because the near-miss is the lesson:** the first cut of this fix *created* the mirror-image bug. Making the record follow the process is only safe if "the process" reflects a real request — and both callers were collapsing an absent mode to the fail-closed fallback before `spawnAgent` saw it. With the write-back added, a body-less `create_agent(resumeSessionId)` — the fleet-recovery shape — silently and permanently demoted `bypass` agents to `ask`. Pre-PR the same call demoted only the *process*, and the next record-driven respawn healed it; adding the write removed that self-healing. Reproduced on real processes (`record: bypass → ask`, nothing logged), fixed by decision 6, and pinned by the body-less-resume integration test. **Generalizable:** when you make A follow B, first check that B is not itself synthesized from a default.

  Also caught: `permissionModeFromStored`'s alias table was an object literal, so eight well-known strings (`"constructor"`, `"__proto__"`, `"toString"`, …) resolved to `Object.prototype` members typed as `PermissionMode`. Never an escalation path — no prototype member equals a real mode — but a function reaching `PERMISSION_MODE_INFO[mode]` throws on dashboard mount. Now `Object.create(null)`, with those keys as negative test cases.
- **Rationale — migrate over passthrough:** a Zod-passthrough would leave two spellings alive in memory forever, turning every downstream comparison into a two-value check that a later edit gets half-right. Normalizing at the boundary keeps exactly one spelling past it. It also matters for *warnings*, not just values: routed through the template loader's invalid-mode notice, a legacy `"default"` would have been reported as a user typo — same final value, wrong explanation in the log.
- **A trap worth recording: `mcp/tools.ts` must NOT import from `@autonomos/core`.** The obvious way to kill the duplicated value list is to import `PERMISSION_MODES` into the shared tool definitions. That **breaks the packaged build at runtime**: `tools.ts` is bundled into `channel-server/dist.mjs` with `--packages=external`, and `build-binary.ts` *copies* that bundle into the binary's bundle dir, where a bare `@autonomos/core` specifier does not resolve — every agent spawn would fail, in the packaged build only, with local `make check` green. This was caught by inspecting the emitted bundle's import list, not by any test. The values stay hand-copied there, and `tools-permission-schema.test.ts` asserts the copy matches core exactly — the same drift protection without the runtime dependency.
- **Alternatives considered:**
  - *Record wins, explicit mode ignored on resume* — mirrors how `reattachCwd` treats the record as authoritative for `workingDirectory`. Rejected: it silently discards an explicit instruction, so "restart B as bypass" would stop working with no error — trading a visible inconsistency for an invisible one.
  - *Caller wins, record NOT updated* — the status quo made deliberate. Rejected: this is the reported bug.
  - *Rename to `"prompt"`* — accurate, but the UI already says "Ask" and matching the shipped label costs nothing.
  - *Add a real server-side default-permission setting* — would make the dashboard control mean what users already assume. Deliberately **not** done: it is a feature, not a fix, and Terry scoped this to the bug. The control's help text now states its browser-local scope instead.
- **Consequences:** A resume carrying an explicit mode now updates the record, so the API, dashboard, and org chart report what the process is actually running. Agents can read a peer's mode from `list_agents`. Existing records/templates/browsers holding `"default"` load as `"ask"` with no operator action. `AgentInfo.permissionMode` is optional so a NEWER channel server stays readable when talking to an older server that doesn't send the field. The `list_agents` line gains a trailing ` — <mode>` segment, which any consumer parsing that text by splitting on `—` should know about.
- **Consequence for callers — the rename is behavior-preserving; do NOT migrate autonomy because of it.** Recorded because it was actively misread during review, and acting on the misreading would have raised the whole fleet's autonomy for no reason. `ask` maps to exactly what `default` mapped to: for Claude Code, **no flag at all** (asserted in `permission-modes.test.ts`, and confirmed on a real spawn's argv). Nothing about tool-approval enforcement changes in this PR. If a worker spawned with the old `"default"` ran a task end-to-end without stalling, that is Claude Code's own built-in behavior under whatever settings that session got — autonomOS selects a flag, it does not enforce approvals — and it behaves identically after this change. The one real caller-visible change is on the wire: a request naming `"default"` is now the *legacy* spelling. It is accepted and normalized to `ask` **at the REST boundary** — which is the path that matters, because autonomOS-spawned agents reach `create_agent` through the channel server, and that forwards to `POST /api/agents`. So an agent still holding the pre-rename tool schema keeps working.

  It is deliberately NOT added to either MCP `enum`. The published enum is the machine-readable field a model treats as current, so listing the retired spelling there would teach it as current and — worse — make the two transports advertise different vocabularies, which is the divergence class this entry exists to close. A test now pins both transports to `PERMISSION_MODES`. Relatedly, the `create_agent` schema advertises **no** `default` key at all: `default: "ask"` would claim omission yields `ask`, which is false on a resume (omission PRESERVES), and a client materializing that advertised default would send `ask` explicitly and re-level a deliberately autonomous agent — reproducing the very demotion described above.
- **Explicitly NOT fixed, flagged during investigation (each deserves its own ticket):**
  - **`scheduler.ts` is an uncovered permission surface with an INVERTED default.** It spawns `claude` directly via `child_process`, entirely outside `PermissionMode`, and pushes `--dangerously-skip-permissions` whenever `schedule.autonomous !== false` — **default-ON, fail-open**, the inverse of the fail-closed agent default. Out of ADR-045's scope and still out of this one's.
  - **`autoTrust` IS re-derived from settings on every respawn** — not `permissionMode`, but a permission-adjacent global where flipping the setting changes already-persisted agents' behavior on their next restart. The pattern the reporter feared, in a neighbouring field.
  - **`PATCH /api/agents/:id` accepts a mode but does not restart the PTY** — the record changes while the live process keeps its original flags until the next restart. A second, narrower way for display and reality to drift.
  - **`CreateAgentPanel` always sends `permissionMode` explicitly,** so a template's declared mode loses to the browser-local default unless the user manually clicks that template card.
  - **Resuming an EXTERNAL CC session applies the current browser default** rather than anything that session had.
- **Verification:** mutation-tested per claim, with the coverage boundary stated rather than implied.
  - Making `markRunning` ignore its `permissionMode` patch → 2 persistence tests red.
  - Removing the legacy alias → 5 tests red across core, agent-record and template migration.
  - Restoring the caller-side pre-collapse (the demotion regression) → the body-less-resume integration test red.
  - Restoring the literal `"Default: default"` schema wording → the prose guard red. Worth recording: the FIRST version of that guard scanned only `'quoted'` tokens and so passed on the exact string it was written to catch. It now checks unquoted forms and the `mcp.ts` zod prose too.
  - **Boundary:** the persistence unit tests call `markRunning` directly, so removing the write from `runtime.ts`'s reattach leaves a plain `make check` green. The spawn-path half is covered only by `permission-mode-resume.test.ts`, which is RUN_INTEGRATION-gated (CI runs it; a bare local `make check` does not). Said plainly because the alternative — a file header implying end-to-end coverage that did not exist — is the exact defect this project keeps hitting.
  - **Measurement gotcha, cost two CI runs:** you cannot assert on a LIVE `bypass` PTY in CI. `--dangerously-skip-permissions` is refused by the real `claude` binary under CI/root (the constraint behind ADR-045's default flip), so a bypass agent starts, is rejected, exits, and the ADR-049 crash net respawns it under a FRESH `providerSessionId` — after which nothing in `ps` carries the original agent id and a live-process probe reads `no-process` however long it waits. A fixed wait failed; polling to a 45s deadline failed the same way. The suite now asserts on the server's own `[runtime] spawning:` line, which is the concrete argv handed to the OS and is stable regardless of whether the process survives. Two wrong diagnoses preceded the right one (argv truncation, then slow respawn), both discarded because the evidence didn't fit — the other bypass argv checks had passed on the very same runner.
  - Full suite: 767 server + 272 dashboard; 786 server with `AUTONOMOS_INTEGRATION=1`.
- **Source:** autonomOS CC session (PermissionModeRefactor@autonomOS), from a user bug report relayed by Terry.

## ADR-062: Remove the scheduler's `isolated` target — the last execution path outside `PermissionMode`

- **Date:** 2026-07-29 — **Decided by:** Terry, on evidence gathered by PermissionModeRefactor@autonomOS. Terry chose removal over retrofit and specified the accept-and-ignore deprecation shape.
- **Partially reverses ADR-026**, which shipped the scheduler with two execution modes. The `agent:<name>` mode, the Croner engine, storage layout, overlap policies, concurrency limits and catch-up are all unchanged. Also retires the `sessionTarget: "isolated"` shape ADR-021 borrowed from OpenClaw.
- **Follows up ADR-061**, which flagged this as out of scope.
- **Context:** `scheduler.ts` spawned a headless `claude -p` child for `target: "isolated"`, entirely outside `PermissionMode`, pushing `--dangerously-skip-permissions` whenever `autonomous !== false`.

  Three things the investigation established, none of which were obvious going in:

  1. **`autonomous` is a pre-ADR-045 survivor, and the mechanism matters.** The scheduler shipped 2026-04-13 (#132); ADR-045 landed 2026-06-26 (#257). `autonomous?: boolean` is the same coarse fail-open boolean ADR-045 replaced everywhere else. It survived **only because it is spelled `autonomous`, not `autonomousMode`** — ADR-045's stated safety mechanism was "rename the field so the type checker flags every consumer", which structurally cannot see a same-shaped field under a different name. Generalizable: a rename-driven migration finds every *consumer of that field*, never a *parallel field with the same design*. Grep the shape, not just the name.
  2. **It was fail-open in three places, not one** — the executor's `autonomous !== false`, the MCP schema's `.default(true)`, and the REST route's `: true`. Any one of them alone grants full autonomy to a caller that simply omits the field.
  3. **It was already inert for the other half of the product.** `executeAgentSend` never read it — an `agent:` run's autonomy is the receiving agent's `permissionMode` — yet `create_schedule` advertised the field regardless of target.
- **Decision:** **Remove the `isolated` target and its executor** rather than retrofit `PermissionMode` onto it. `agent:<name>` is the only target.

  Deprecated to **accept-and-ignore no-ops**, not deleted, so a schedule file or an MCP client written before the removal still loads instead of failing validation (the ADR-058 `capabilities` shape): `autonomous`, `workingDirectory` (which was **required**), `template` (*already* dead — advertised in the schema, read by nothing), `onComplete`, and `RunRecord.output`. An existing `isolated` schedule loads, stays editable, warns once at startup naming itself, and fails any run with a message naming `agent:<name>`.
- **Rationale — why removal, and why fail-closed was not the alternative.** The obvious fix is flipping the default to fail-closed. Measured against the real binary, that does not secure the feature, it silently ends it: a headless `claude -p` with no permission flag created nothing (`--permission-mode acceptEdits` and `--dangerously-skip-permissions` both completed the task). Worse, **"no flag" is not a defined behavior for a scheduled run** — it inherits the operator's `~/.claude/settings.json`, which on the test machine meant plan mode. A default that turns every schedule into a silent no-op depending on ambient user settings is the "wrong result, no error" class, not a fix for it.

  Usage decided the rest: of two schedules on the machine, the only ENABLED one is an `agent:` target and the single `isolated` one is disabled. Retrofitting `PermissionMode` onto a path with no enabled users, to keep a capability nobody uses, buys a second spawn route to keep in sync forever. Removing it deletes the fail-open surface, the second spawn path, the hand-rolled flag mapping, and four inert fields at once.
- **Consequence — schedules now depend on agent liveness.** `isolated` was the only mode that worked with nothing running. A dead target agent means a failed run until it is respawned. Accepted deliberately: that is the behavior of the mode already in use.
- **`onComplete` — two mistakes, in opposite directions, both worth recording.**

  *First:* the obvious tidy is to un-gate it so it survives for the remaining target, since `target === "isolated"` is now unreachable-by-creation. That would have been wrong. For `isolated`, a run completed when the child exited, so "completed: success" meant the task had RUN. For `agent:`, `executeAgentSend` reports success as soon as `routeMessage` returns no error — **the agent has not started**. Un-gating would have shipped a notification announcing a completion that had not happened. The only thing pointing at this was an existing test asserting "does NOT deliver onComplete for agent mode" with no rationale attached. **Generalizable: before rehoming a feature onto surviving semantics, check the semantics actually match — an arbitrary-looking gate may be load-bearing.**

  *Second, caught in review:* the fix for that was implemented as "leave the gate in place, i.e. dead" — and it was **not dead**. `isolated` cannot be *created* any more, but it still exists *on disk*, which is precisely the population this entry protects. Those schedules satisfy the gate, so an enabled recurring one would have emitted a gateway message into a live agent's context on **every fire, forever** — `consecutiveFailures` is incremented but never read, so nothing bounds it — while six other places (this ADR, the changeset, CLAUDE.md, the core type, and both MCP schemas) called the field a no-op. Verified by executing the real on-disk schedule through the real code.

  `deliverOnComplete` and its gate are therefore **deleted**, not gated. **Generalizable: "deliberately dead code" and "unreachable code" are different claims. If the reason a branch is dead is that its input can no longer be *created*, check whether the input can still be *loaded* — and prefer deleting to commenting, because a comment cannot be executed and so cannot be wrong in a way tests catch.**
- **Alternatives considered:**
  - *Retrofit `PermissionMode` onto the isolated executor* — one vocabulary, keeps the capability. Rejected on usage: a second spawn path to keep in sync, for a mode with no enabled schedules.
  - *Flip the default to fail-closed (`ask`)* — measured to break the feature rather than secure it, and dependent on ambient user settings. See rationale.
  - *Default to `auto` (acceptEdits)* — the least-permissive mode that still completes work, and genuinely viable. Still leaves a second spawn path outside the agent lifecycle.
  - *Require an explicit mode for isolated schedules* — safest posture for a retained path, but a breaking MCP contract change to preserve an unused capability.
  - *Delete the deprecated fields outright* — a schedule file on disk would fail to load, and an MCP client holding the old schema would hard-fail. Accept-and-ignore keeps operator data loading.
- **Verification:** `scheduler-isolated-removal.test.ts` covers both halves — the hard stop (validation rejects `isolated` naming the replacement; a run fails with an actionable error; startup warns exactly once, naming the schedule) and the soft landing (a config carrying all four deprecated fields still validates and round-trips verbatim; `autonomous: true` reaches no spawn because none exists; a schedule with no `workingDirectory` validates). The pre-existing scheduler suites were re-pointed from `isolated` to `agent:worker` — they were testing scheduler *mechanics* (overlap, concurrency, queueing) and only used `isolated` as a convenient target. Every claim above is mutation-verified: re-allowing `isolated` in validation, degrading the run error to a bare "unknown target", deleting the startup warning, restoring the route's fail-open `autonomous: true`, dropping `workingDirectory` on write, and wiping the deprecated fields on a partial update each turn a test RED. Full suite: 795 server + 272 dashboard with `AUTONOMOS_INTEGRATION=1`.
- **Flagged, not fixed:** `schedule.notify` has **zero readers** in `packages/server/src` — accepted, stored, advertised in both MCP schemas, acted on by nothing. Exactly the category this entry claims to have swept (`template` was the same shape), so the sweep is incomplete by one field. Pre-existing and independent of the removal; recorded rather than folded in.
- **Source:** autonomOS CC session, follow-up to ADR-061's not-fixed list.

## ADR-063: Keyboard shortcut registry and the key-capture boundary

- **Date:** 2026-07-29
- **Who decided:** Terry (design approved via TeamLead relay; recommended option chosen), design + implementation by Shortcuts@autonomOS
- **Context:** A user asked for CMUX-style ctrl+1-4 quick tab switching. The dashboard had exactly one global shortcut (Cmd/Ctrl+B, an inline capture-phase window listener in App.tsx) and a second, independent hand-list in xterm's `attachCustomKeyEventHandler` (declining ctrl+d/w/b) — two already-divergent sources of truth for which keys belong to the app vs the terminal. The hard problem of this domain is the **key-capture boundary**: xterm.js `stopPropagation()`s every key it handles in the bubble phase (so app shortcuts only work as capture-phase listeners), and every chord the app reserves is a chord a focused terminal loses forever.
- **Decision:** A central shortcut registry (`packages/dashboard/src/shortcuts/registry.ts`) — one table of `{id, chord, description, category, boundary, when?, run}` (v1 carries only `boundary: "app-reserved"`; the design's second class, `app-when-free` — fires only when no terminal/editable has focus, what a bare-letter chord needs — is deliberately not shipped as a dead union member until its first shortcut, per review) — consumed by exactly two enforcement points: (1) ONE window-level capture-phase dispatcher (`useShortcuts`, gated on auth) that `preventDefault+stopPropagation+run`s app-reserved matches, so a focused terminal never sees them; (2) a one-line consult in xterm's `handleKeyEvent` (`isReservedChord(e) → return false`) as defense in depth that keeps the terminal's decline list mechanically synchronized with the registry. v1 bindings, all app-reserved: **mod+1-8 = focus pane N in visual order, mod+9 = focus LAST pane, mod+B = toggle sidebar (migrated from the inline handler, now auth-gated), mod+/ = shortcut help overlay** (rendered FROM the registry so it cannot drift), Escape = close overlay (reserved ONLY while the overlay is open, via `when`). `mod` = ⌘ on Mac / Ctrl elsewhere via the existing `hasPrimaryModifier`. Pane enumeration is a depth-first walk of `api.toJSON().grid.root` (`orderedPaneIds`) — NOT `api.panels`.
- **Rationale:**
  - **mod+digit, not the literally-requested ctrl+digit.** Research corrected three assumptions. (1) ⌘1-9 IS interceptable in Chrome on macOS — Chromium's reserved-key list covers tab lifecycle (⌘W/T/N/Q, ⌃Tab) but deliberately not select-tab-by-index. (2) ctrl+digit is NOT free in a terminal: xterm encodes ctrl+3→ESC, ctrl+4→FS … ctrl+8→DEL, so "ctrl+1-4" silently steals Escape from every full-screen TUI, including Claude Code itself. (3) CMUX is a native Ghostty app whose ctrl+digit scheme its own users contest (cmux#577, #1048 request ⌘digit); Ghostty, Warp, iTerm2 and VS Code all converge on mod+digit with **mod+9 = last tab**, which v1 follows. **Accepted cost, recorded explicitly (review catch):** on non-Mac platforms `mod` IS Ctrl, so mod+3..8 reserve the very encodings above (Linux dashboard: Ctrl+3 no longer sends ESC to the shell). This is a Mac-first tradeoff consistent with `handleKeyEvent`'s pre-existing Ctrl+K/A/O behavior via the same `hasPrimaryModifier` switch — and it is enforced as a conscious decision: the registry test requires every `mod+` chord to carry a documented non-Mac cost entry, so a future `mod+r` cannot silently eat readline reverse-search on Linux.
  - **`api.toJSON()` walk, not `api.panels`.** `api.panels` flat-maps a Map in group-CREATION order. Split right, then split the left group again: visual order A|C|B, `api.panels` order A,B,C — a positional shortcut that is *usually* right and occasionally wrong is the worst failure mode. The serialized grid tree's branch children are in spatial order and leaf `views` are tab order; the walk is deterministic and unit-tested against exactly that fixture.
  - **`panel.api.setActive()`, never store `switchPane`.** `setActive` is the same non-destructive path as a physical tab click; `switchPane` can trigger a full workspace `fromJSON` rebuild that remounts terminals. The existing dockview→store writeback mirrors the activation for free.
  - **Boundary posture:** everything unregistered passes through untouched (silence = passthrough at the xterm layer, VS Code's `commandsToSkipShell` posture keyed by command). Conditional reservation (`when`) keeps Escape with the terminal except while the overlay is open. A registry unit test enforces: no duplicate chords, nothing browser-unreservable (⌘W/T/N/Q), no mac-secondary-ctrl (terminal-sacred) chords.
- **Alternatives considered:**
  - *ctrl+1-4 exactly as requested (alone or as aliases)* — rejected/deferred by Terry: steals ctrl+3(ESC)/ctrl+4(FS) encodings from TUIs; contested even upstream in CMUX.
  - *dockview's built-in keyboard-nav module* (`keyboardNavigation` prop; ctrl+]/[, F6) — dormant and complete, but relative-only (no positional "pane N") and registers its own document listener outside the registry. Kept off; relative nav can be added registry-native later.
  - *Full user-customizable keybindings / command palette / chord sequences* — out of v1 deliberately; the registry shape (id-keyed, chord as data) doesn't preclude any of them.
  - *Bare `?` for help* — a single-key global is unsafe with 15 unguarded inputs and terminals; mod+/ is browser-free and standard.
- **Follow-ups flagged, not fixed:**
  - `handleKeyEvent`'s hardcoded ctrl+d/w swallow is residue of the DELETED legacy split shortcuts (ADR-047 phasing; ROADMAP #40's Ctrl+D/Shift+D/W): the handlers are gone but the swallow remains, so ctrl+d (EOF) and ctrl+w (delete-word on mac, where ctrl is not `mod`) are reserved-for-nothing. Freeing them back to the terminal (or reintroducing split/close shortcuts through the registry) is a behavior decision for its own PR — this one deliberately changes no terminal-visible key behavior **on macOS** (on non-Mac, the mod+digit reservations are themselves a documented, accepted steal — see Rationale).
  - Both document-level bubble-phase Escape handlers (popovers, notification panel) are dead while a terminal has focus — latent today, masked by focus-follows-click; candidates for registry migration.
  - PWA caveat for #71: in installed-PWA mode Chrome reserves NOTHING (even ⌘W is interceptable) — the browser-reserved deny-list must become launch-mode-aware if the dashboard ships as a PWA.
- **Source:** Investigation + design by Shortcuts@autonomOS (three-agent sweep: keyboard infra, dockview pane model, CMUX/VS Code/Ghostty/Chromium conventions research — sources in `docs/research/keyboard-shortcuts.md`); Terry approved the recommended option 2026-07-29.
## ADR-064: `send()` acks DELIVERY, not routing — and `broadcast://` / `slack://` are removed

- **Date:** 2026-07-29 — **Decided by:** Terry (directed the work, chose the binary ack over a three-state one, and called both removals), routed via TeamLead@autonomOS → CodexGemini@autonomOS, implemented by DeliveryAck@autonomOS.
- **Builds on:** **ADR-060**, which removed the Codex idle gate. That is what made this fixable: while the gate existed, a message could legitimately sit queued behind a busy agent, so "delivered vs queued" was genuinely ambiguous and no truthful ack was definable. With the gate gone the only remaining queue is a genuine TRANSPORT failure, so "accepted by the destination" became a statement we can actually make.
- **Closes a follow-up recorded in ADR-055**, which deferred exactly this: *"**Delivery-ack semantics** ('ack means DELIVERED, not ROUTED') is deferred pending CodexGemini's idle-gate-removal PR, to avoid rebuilding the ack path underneath them."* That sequencing held — ADR-060 landed first and this builds on it rather than fighting it. ADR-055's OTHER deferred item, Layer-2 strong-token enforcement, is untouched here and remains open.
- **Context — the bug.** `routes/gateway.ts` set `success: error === null`, where `error` came from `routeMessage`. That return reflected RESOLUTION, not delivery: `routeToAgent` called `deliverToCodex(...)` — a `void` fire-and-forget — and then `return null` unconditionally. So a sender was told "sent" for a message that:
  - was injected into a Codex daemon that was not listening (dead port after a respawn),
  - was injected into an agent whose `--remote` TUI had created no thread (documented to last MINUTES for a promptless agent on codex 0.144.6),
  - was refused by the daemon (`turn/start` error),
  - was written into a Claude Code socket that was registered but already CLOSING — `WSContext.send()` does not reliably throw there, and "no exception" was being read as delivery,
  - or, worst, was addressed `slack://` — whose only adapter was a `StubAdapter` whose `send()` was a `console.log` returning `stub-msg-${Date.now()}`. That path reported success for every message by construction.

  This cost a debugging afternoon: an agent misdiagnosed a Codex deadlock because the "success" it was reasoning from was not one.
- **Decision.**
  1. **`null` from `routeMessage` now means the destination ACCEPTED the message.** The signature is deliberately unchanged (`Promise<string | null>`) — the two-state shape was never the problem, the meaning of `null` was. Anything non-null is a sender-facing explanation.
  2. **Per-provider, "accepted" means:** *Claude Code* — the write landed on an OPEN, registered, token-verified channel-server socket. *Codex* — the daemon replied to `turn/start`.
  3. **NOT an end-to-end receipt, and the comments say so.** There is no application-level ack from the far side of the CC socket, so "delivered" does not mean the agent read it or can answer. Building that receipt was considered and deliberately skipped (Terry: "we don't need to actually guarantee the destination can respond").
  4. **Binary, not three-state.** The first proposal had a `queued` state on the wire. Terry rejected it as over-built and he was right: a buffered message is reported `success: false` with a reason string that says it is buffered, is retried automatically, and must NOT be re-sent. Truth lives in the reason string; the enum stays out of the protocol.
  5. **`deliverToCodex` returns a promise that settles only on a TERMINAL outcome** — the `turn/start` reply, or teardown. A message buffered for a transport retry settles at neither, by design, so **every caller must bound its own wait**. The router bounds it at `DEFAULT_DELIVERY_ACK_MS` (2s).
  6. **Remove `broadcast://all`.** Zero production usage (no internal caller; no schedule sets `onComplete` at all). It ack'd success unconditionally — including to a fleet of zero and when every recipient was unreachable — and let any agent inject a turn into every running Codex agent, i.e. fleet-wide instruction execution from one tool call. It was also the one path where a truthful binary ack is not definable (N recipients, partial outcomes), so removing it is what let decision (4) stay simple.
  7. **Remove `slack://` and the whole platform-adapter framework** (`adapters/`, `registerAdapter`, `setRoutes`/`getRoutes`, `routeInbound`, `routeToPlatform`, `shutdownGateway`). `Platform` had exactly one member and its only implementation was the stub above.
  8. **Raise the channel server's `send_result` wait 2s → 5s.** At 2s it raced the gateway's own 2s ack window: a delivery confirmed just after the window would arrive to a request the channel server had already abandoned and deleted, and the agent would be told "timeout" for a message that landed. 5s makes it a backstop for a wedged gateway rather than the bound that governs normal sends.
- **Rationale — why awaiting `turn/start` does not couple the sender to the recipient's turn.** The daemon acks `turn/start` on ACCEPT, not on turn completion. ADR-060's measurement is the evidence: one condition injected into a thread held busy by a synchronous MCP call for **90 seconds**, and `turn/start` "returned OK every time" — under a **30s** RPC deadline. Had the reply been gated on turn completion, that call would have timed out, been re-queued and retried, and the measurement would have shown duplicates rather than a clean single delivery. Live QA corroborates (a `wait_agent`-blocked agent released ~4s after injection). **Residual uncertainty, named:** this proves the ack is not gated on turn completion; it does not prove the ack is always instant. The bounded window is what makes that gap safe rather than something that had to be pinned down first — if a future Codex ever blocks, the window expires and we report not-delivered instead of hanging.
- **Alternatives considered and rejected:**
  - *Fire-and-forget on Codex* (Terry raised it). Rejected: that is the status quo for the Codex path, and Codex is where the bug actually bit. Dead-daemon and threadless-agent both keep reporting success.
  - *A three-state `queued` ack.* Rejected as over-built — see (4).
  - *Report a buffered message as a hard error.* Rejected: it invites a re-send, and a Codex duplicate makes the agent execute the same instruction twice, which the integration suite already records as worse than a drop.
  - *Verify socket + thread synchronously without awaiting the reply.* Rejected: reimplements half of `drain()`, i.e. MORE code than awaiting, for a weaker guarantee.
  - *Keep `broadcast://` with a counts-based ack* ("3 delivered, 1 queued"). Rejected: no honest `success: boolean`, and it is the complexity that decision (4) exists to avoid.
- **Test evidence — every new assertion was mutation-verified.** Five mutations, each reintroducing a specific bug; all five turn the suite RED, and sources were hash-verified as restored afterward:

  | mutation | result |
  |---|---|
  | M1 Codex fire-and-forget (`deliverToCodex(...); return null;`) | RED — all 3 transport-failure tests |
  | M2 drop the CC `readyState` guard | RED — the CLOSING-socket test |
  | M3 `broadcast://` returns null again | RED — the broadcast refusal test |
  | M4 settle the ack on ENQUEUE instead of the `turn/start` reply | RED — all 3 transport-failure tests |
  | M5 always report not-delivered | RED — all 3 happy-path tests (proves they are not vacuous) |
  | M6 discard the scheduler's `onComplete` return again | RED — the new onComplete-warning test |
  | M7 channel-server deadline == ack window (the actual race) | RED — both the ordering and headroom assertions |
  | M8 deadline strictly greater but only 500ms headroom | RED — the headroom assertion ONLY |
  | M9 ack window dropped to 50ms, near real delivery latency | RED — the latency assertion ONLY |

  | M10 `dispose()` clears the queue WITHOUT settling | RED — both delivery-promise tests |
  | M13 reuse a disposed controller AND leave it registered | RED — the replacement-controller test |

  M7–M9 fail **different** assertions, which is the point: M8 passes the `>` check and fails only on headroom, so the two are not redundant — `>` alone is satisfied by 2000 vs 2001, which still races once the gateway's pre-window name resolution is counted.

  **The mutation pass found two real defects in the tests themselves, which is the argument for doing it at all:**
  1. **M10 originally HUNG the runner instead of failing it.** An unsettled delivery promise means a bare `await` never returns, and `node:test` has no default per-test timeout — so a regression would have sat silent until CI's wall clock killed the job hours later, pointing at nothing (the failure mode `real-codex-daemon.ts` already guards its `close()` against). Fixed by a `settlesWithin` helper in `helpers/wait.ts` that bounds any promise whose contract is "settles on a terminal outcome"; M10 now fails in ~2s with a message naming the broken contract.
  2. **A test asserted the opposite of its own intent.** It was written as "settles an enqueue onto an already-disposed controller" and checked the log with `/queued \(6 chars/` — which is a SUBSTRING of the disposed branch's `"NOT queued (6 chars)"`, so it passed against a mutant that reused the dead controller. Worse, the branch it named is unreachable from outside the module (`getOrCreate` treats a disposed controller as absent). Renamed to what it actually covers, with the uncovered branch stated explicitly, and the assertion anchored on the agent-id prefix so `NOT queued` can no longer satisfy it.

  Also recorded in that test: the property it guards is held by **two redundant mechanisms** (`disposeCodexControl` deletes the registry entry; `getOrCreate` independently treats a disposed controller as absent), so **no single mutation turns it red** — proving it non-vacuous required defeating both at once. A future reader running one mutation would otherwise conclude the test asserts nothing.

  **M4 is the one that matters most.** It keeps the `await` and the `if (!delivery.delivered)` check fully intact and moves only WHERE the promise settles — the shape a well-meaning "resolve earlier so send() returns faster" refactor would produce. An assertion surviving M1 but not M4 would be guarding syntax rather than semantics.

  The three integration assertions that previously read `assert.equal(err, null, "delivery is async — the send itself is ack'd")` were **inverted, not deleted** — that comment was the bug written down and locked in.
- **Consequences.**
  - `send()` can now block up to ~2s, but only when the transport is genuinely sick. **Measured** against a loopback daemon (12 sends): the first costs 14.8ms (connect + initialize + thread discovery), steady-state 0.2ms median / 0.3ms max — so the window is ~135x the cold path. The variable that could move it is a real daemon's responsiveness under load, not our overhead.
  - **A false negative is now possible and is accepted:** a message buffered and landing 40s later was reported "not delivered". Under-claiming is the safe direction, and the reason string tells the sender not to re-send.
  - `scheduler.ts`'s `agent:<name>` mode records honest run failures for free — it reads the same return and previously logged green for undelivered prompts.
  - **A second scheduler silent failure, found and fixed here:** `deliverOnComplete` *awaited* `routeMessage` and discarded the result. `routeMessage` reports non-delivery by RETURNING a reason rather than throwing, so the caller's `.catch()` never fired — a schedule's completion notice could go nowhere with no trace anywhere. Tolerable while the return only meant "resolved a recipient"; not once it means "accepted". It now warns, naming the schedule AND the destination URI.
  - Agents spawned BEFORE this ships still carry `broadcast://all` in their baked-in system prompt (that text is fixed at spawn and cannot be revised for a live agent), so the router answers `broadcast://` with a pointer to `agent://` rather than a bare "unknown scheme".
  - The dashboard message feed now fans out only on confirmed delivery, matching what the Claude Code branch always did.
- **Found in review, and fixed rather than deferred.** The first cut left the removal half-done, and every leftover was the same shape as the bug: something claiming to work that didn't.
  - **Five stale comments still asserted "the sender is ack'd on enqueue"** — the premise this entry inverts — including one ~740 lines below the rewritten header in the same file, so `codexControl.ts` contradicted itself. Rewritten, not deleted: the reasoning around them (why an unbounded compacting hold is a silent drop) survives intact and is now *stronger*, because the sender has been explicitly told not to re-send.
  - **`settings.gateway` and `settings.routes` had lost their last readers** (the adapter connect-loop and `setRoutes`). Left in place they would be settings a user can toggle that do nothing — the same class of lie as a false ack. Both now scrub on read via the existing `REMOVED_KEYS` idiom, which already handles five other removed features. Two tests inverted accordingly: `gateway` was previously scrubbed *partially* (slack kept, because the adapter read it) and routes were filtered *per-platform* (slack kept, because `setRoutes` fed them) — with both readers gone, keeping the slack half would be a rule that silently never fires.
  - **`ChannelRoute` / `PlatformAdapter` / `GatewayReply` were unreferenced** in core. An unused *export* is never a compile error, so nothing would ever have caught them.
  - **The 2s/5s ordering was a correctness contract enforced by nothing** — two literals in two files on opposite sides of the esbuild bundle boundary, each with a prose comment describing the relation. Either could be edited alone and both files would still read as correct. Now one leaf module (`gateway/deliveryTimings.ts`, import-free so it survives bundling — the ADR-061 trap) plus `delivery-timings.test.ts` asserting the ordering AND a minimum headroom, because `>` alone is satisfied by 2000 vs 2001 while the gateway's pre-window name-resolution work still has to fit in the gap.
- **A pre-existing gap surfaced, deliberately NOT fixed here:** `fanOutToDashboard` fans out to an empty set in every deployment — nothing in `packages/dashboard` opens a gateway socket, so no client ever sends `dashboard_connect`. Moving the Codex fan-out to after delivery confirmation is still correct (the feed should not be born lying if a consumer is ever built), but the comments now say plainly that no live consumer exists, so a reader does not mistake it for one.
- **Deliberate leftovers, recorded so they are not mistaken for oversights:** `GatewayMessage.platform` retains its `"slack"` filler for agent-to-agent messages (`fromUri` is the real source of truth), keeping `Platform` alive as a one-member type. Dropping `platform`/`platformMessageId`/`chatId` — all written and never read — changes a wire type shared with the bundled channel server, so it wants its own change. A hardcoded `"slack"` surviving a PR headlined "slack:// removed" reads as an oversight, hence this line.
- **Source:** autonomOS CC session, gateway messaging area. Directed by Terry; routed TeamLead@autonomOS → CodexGemini@autonomOS; implementation, mutation testing and this entry by DeliveryAck@autonomOS.

## ADR-065: Key-capture boundary cleanup — free the dead ctrl+d/w reservations, route all Escape dismissal through the registry

- **Date:** 2026-08-03
- **Who decided:** Terry (both directions approved explicitly: "restore standard terminal behavior" for the freed keys; "do it in one go" for the Escape migration), implemented by Shortcuts@autonomOS
- **Context:** Both items were flagged-not-fixed in ADR-063. (1) `handleKeyEvent` still swallowed ctrl+d/w/b on every platform — residue of the pre-dockview split shortcuts (Ctrl+D split / Ctrl+W close / Ctrl+B sidebar, deleted with the legacy engine in ADR-047). The actions died; the reservations lived on: on a Mac, ctrl+d sent no EOF, ctrl+w deleted no word, ctrl+b was no tmux prefix — keys eaten with no app action, the "reserved for nothing" failure mode. (2) The popovers' Escape handlers (useClickOutside × 4 consumers, NotificationPanel's duplicate) were document-level bubble-phase listeners — dead whenever a terminal had focus, because xterm stopPropagation()s every key it handles. Masked by focus-follows-click; broken the moment focus returned to a terminal (ESC fed to the shell, panel stayed open).
- **Decision:** (1) Delete the legacy ctrl-swallow and the dead `case "b"`/`case "d"` mod-switch arms. Ctrl+d (EOF), ctrl+w-on-Mac (delete-word) and ctrl+b-on-Mac (tmux prefix) reach the shell again; ctrl+b on non-Mac remains registry-reserved (it IS `mod+b`). **`mod+w` stays declined on all platforms** — on non-Mac, Ctrl+W is Chromium's unpreventable close-tab, so "standard terminal behavior" is unreachable for it; declining only stops xterm from invisibly deleting a word from the shell's line buffer as the tab dies. (2) A module-level **escape stack** (`shortcuts/escapeStack.ts`): anything dismissible pushes its close callback while mounted-open (help overlay, all useClickOutside popovers, notification panel); the registry's single `ui.dismiss` entry (replacing `help.close`) is Escape, reserved only while the stack is non-empty, closing LIFO. Terminals keep Escape whenever nothing is open.
- **Rationale:** (1) is a strict restoration — the swallowed chords fired no app action on any platform, so freeing them costs nothing and returns three standard shell inputs; the one deliberate exception (`mod+w`, incl. shift+W = close-window) is documented at the case with its reasoning. One additional byte-level delta the sweep surfaced (review): on Linux, real ctrl+alt+d / ctrl+alt+b were swallowed and now emit xterm's standard ESC-prefixed encodings — consistent with the restoration; Windows AltGr is UNAFFECTED either way (xterm's third-level-shift handling bypasses keydown, and the old swallow never cancelled the input path). (2) reuses the mechanism ADR-063 built rather than adding special cases: one capture-phase Escape entry that wins over xterm, one `when` gate, LIFO nesting for free — replacing three inconsistent listeners, two of which were provably dead under terminal focus. Both claims are mutation-verified: restoring the legacy swallow turns 4 unit tests + 1 e2e red; restoring the bubble-phase listener turns the Escape e2e red.
- **Alternatives considered:**
  - *Reintroduce split/close-pane shortcuts on ctrl+d/w* (their original meaning) — deferred, not rejected: Terry chose restoring shell behavior; registry-native split shortcuts remain available on ⌘-chords if wanted later.
  - *Also free `mod+w`* — rejected: the browser owns it un-preventably on non-Mac; sending the byte would mutate the shell's line buffer invisibly as the tab closes.
  - *Store-flag-per-popover `when` gates instead of a stack* — rejected: popover open-state is component-local; N store flags plus N registry entries on one chord would trip the duplicate-chord invariant and hard-code nesting order.
- **Testing:** `escapeStack.test.ts` (LIFO, idempotent cleanup, out-of-order pops); `useTerminal.keyPolicy.dom.test.ts` + `.mac.dom.test.ts` (the policy matrix on both platforms — the mac half via a mocked platform module, since `isMac` is a load-time constant); `useClickOutside.dom.test.tsx` (registration lifecycle, LIFO across two popovers, identity-churn re-registration); e2e: freed ctrl+d delivers `\x04` to the PTY socket; Escape closes the notification panel with a terminal focused WITHOUT leaking `\x1b` to the shell, then reaches the shell once nothing is open.
- **Flagged, not fixed:** Escape typed inside a popover's text field still closes the popover and discards the draft (pre-existing; the registry route neither worsens nor fixes it). The `handleKeyEvent` mod-switch (`k`/`a`/`o`/arrows/Backspace) remains a second hand-list outside the registry — harmless today (all fire real terminal-local actions) but a candidate for the same consolidation.
- **Source:** autonomOS CC session (Shortcuts@autonomOS), direct follow-up to ADR-063's flagged list; Terry's approval 2026-08-03.

## ADR-066: mod+digit targets the SIDEBAR agent list, not open pane positions (reverses part of ADR-063's binding semantics)

- **Date:** 2026-08-04
- **Who decided:** Terry ("I don't mean for it to be on just the top windows bar, I'm talking about the AGENTS tab on the left for each agent row"), implemented by Shortcuts@autonomOS
- **Context:** ADR-063 bound mod+1-8 to "focus pane N in visual order" (VS Code editor-group semantics) with mod+9 = last pane. The original design flagged the ambiguity explicitly — "'Nth agent in the sidebar' and 'Nth open tab' are different features — pick one deliberately" — and picked panes. Building the hold-to-reveal digit hints surfaced that Terry's mental model was the other one all along: digits should switch between AGENTS (the sidebar rows, CMUX's tab list), which is also far more useful in the default solo-pane workflow where only one pane is open at a time.
- **Decision:** mod+1..9 switches to the Nth agent row in the sidebar's RENDERED order — positional 1..9, dropping ADR-063's mod+9=last idiom (a tab idiom; pinning already gives users order control). The Sidebar PUBLISHES its rendered row order to the store (`sidebarRowOrder`): flat = pinned then unpinned; hierarchy = depth-first, skipping collapsed subtrees and non-clickable "stopped" placeholder rows; degraded hierarchy publishes empty (nothing visible = nothing switchable). The action mirrors a row click exactly (`switchPane` + terminal focus + clear unread). Hold-badges render on the rows from the same published list — the hint is the chord. The pane-position machinery ADR-063 built for the old semantics (`orderedPaneIds`, `dockviewApi` handle, the serialization-drift tripwire, tab badges) is **deleted**, not kept dormant: nothing consumes it, and this codebase's recorded failure mode is claims/machinery nothing exercises.
- **Rationale:** The publish-the-rendered-order design is the load-bearing choice. Hierarchy row order depends on component-local state (org-chart fetch, collapsed groups) that no registry action can recompute — deriving the order anywhere else would drift from what the user sees. Publishing from the same memo chain that renders makes WYSIWYG structural: the badge list, the switch target, and the pixels come from one array.
- **Alternatives considered:**
  - *Keep pane-position switching too, on another chord (e.g. alt+digit)* — deferred until asked; two digit metaphors at once is confusing, and split-pane users can click tabs.
  - *Number ALL agents including collapsed-hidden ones* — rejected: a badge on an invisible row can't be seen, and a digit switching to something off-screen contradicts the hint's WYSIWYG promise.
  - *Include the singleton rows (Org Chart/Templates/Schedules) in the numbering* — rejected: Terry said agent rows; singletons have dedicated affordances.
- **Testing:** `sidebarRowOrder.test.ts` (DFS order, collapsed skip, stopped-row skip, case-insensitive collapse keys, positional digits); dispatcher tests against the published order (switch, out-of-range no-op); e2e: mod+2 switches to the second sidebar agent WITHOUT its pane being open, and hold-badges appear on the rows with the digits that actually fire.
- **Source:** autonomOS CC session (Shortcuts@autonomOS), Terry's correction during PR #305.
## ADR-067: Model-override env presets — agent-configured, human-keyed, masked-on-read

- **Date:** 2026-08-03 — **Decided by:** Terry (asked whether we could support a "Kimi CLI" like Claude Code/Codex; chose the env-override-behind-Claude-Code path over a new provider; specified the agent-configures / human-keys division, the "no starter presets", and "single PR").
- **Context — what "support Kimi" actually is.** Investigation (docs/research + web) found two ways to run Kimi (Moonshot) in a terminal: a first-party interactive `kimi` CLI, and — officially documented by Moonshot — pointing the *real* Claude Code binary at an Anthropic-compatible endpoint (`ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic` + `ANTHROPIC_AUTH_TOKEN`). The second needs **no new provider**: Claude Code's hooks, MCP, statusline, permission modes and resume all keep working because it is still `claude`, just against a different backend. `buildBaseEnv` already preserves `ANTHROPIC_*` (PR #214). So the feature is not "a Kimi provider" — it is "a named, per-agent env override," of which Kimi is the first user. A dedicated `kimi` CLI provider was deferred: its make-or-break unknown is whether it emits status telemetry (hooks/event-stream) our `deriveStatus()` can consume, which we have not confirmed.
- **Decision.**
  1. **New first-class entity `EnvPreset`** (`core/types/envPreset.ts`), one 0600 JSON per preset at `~/.autonomos/env-presets/<name>.json`, mirroring `templates.ts`/`schedules.ts`. NOT an overloaded Template — a preset carries a credential and rewrites the backend, a different concern. (`Template.model` was found stored-but-dead at spawn; this feature is the first config that actually reaches a spawned process's env.)
  2. **A preset splits its vars three ways:** `env` (non-secret, plaintext on read), `secretKeys` (the *names* of required secret vars, agent-declared), `secrets` (the *values*).
  3. **The credential boundary is asymmetric — read is a hard wall, write is a surface convention:**
     - **Read is masked everywhere.** `maskEnvPreset` redacts every secret value (last-4, `••••1234`) and is applied by every REST GET and every MCP read. `getEnvPresetRaw` (unmasked) exists solely for the spawn-time injection and is wired to no response.
     - **The agent surface cannot write secret values.** The MCP tools (`create_env_preset`/`update_env_preset`) omit any `secrets` parameter, and the channel-server dispatch explicitly picks only the non-secret fields — so even an agent that crafts a `secrets` field into its tool args has it dropped before the REST call. Agents configure everything *except* the key; the tool descriptions instruct them not to solicit tokens in chat and to send the human to the dashboard.
     - **Humans set the key in the UI.** The REST route (the dashboard surface) DOES accept `secrets` on POST/PUT. An empty value clears a secret; a value that is already masked (a UI round-trip of a redacted read) is ignored, so re-saving a preset never overwrites the real key with its mask.
  4. **Injection is provider-agnostic**, in `runtime.ts` after `provider.buildEnv`, so it covers Claude Code / Codex / Gemini uniformly. Precedence: base env < global `customEnvVars` < per-agent preset (most specific wins). `RESERVED_ENV_KEYS` (now promoted to `shared.ts` as the single source of truth) is stripped from a preset both at create-time validation and again at injection.
  5. **A preset whose required secret is unset refuses to spawn**, with a message pointing at the dashboard Presets tab — launching `claude` against a backend with no auth fails confusingly, so we fail early and clearly, before the record is persisted or the PTY launched.
  6. **`envPreset` persists on the Agent record as the NAME only** (never values), resolved once via the same "explicit param wins, else the record's value stands on a body-less resume" rule as `permissionMode` (ADR-061), and re-applied by `respawnAgent`/`/attach` so an override survives a restart.
  7. **UI:** a new left "Presets" tab (management + the human key-entry surface) and a subtle text pill on each agent's row in the Agents tab. Deliberately **no** Kimi icon and **no** provider relabel — a Kimi-backed agent stays a "Claude Code" agent (it is one); only the row indicator reveals the override.
  8. **No starter presets** — the collection is empty until an agent (or human) creates one. Fully agent-managed by design.
  9. **A code-injection denylist, separate from the control-plane reserved set.** `DANGEROUS_ENV_KEYS` (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`, …) is rejected at create/update and stripped at injection. RESERVED_ENV_KEYS protects autonomOS's *own* integrity; DANGEROUS protects the spawned process from being turned into an arbitrary-code-execution vector by a preset. This closes a real escalation the review surfaced: holding the main token lets an agent curl REST, but it does NOT otherwise let an agent run code inside a *sibling* agent's process — a preset `LD_PRELOAD` would grant exactly that. Injection also exports only secrets whose key is currently DECLARED in `secretKeys` (an orphaned value left after a rename never leaks) and never a masked literal.
- **The honesty caveat, stated not hidden — and NARROWER than an earlier draft claimed (Nox).** What is actually enforced is precise and limited: (a) the preset MANAGEMENT surface — every REST GET and MCP read — never returns a full secret, only a last-4 mask, so an agent cannot *enumerate* keys (its own or another preset's) through the API; (b) no MCP tool or channel path can *write* a secret value; (c) no preset can inject a control-plane or code-injection env key (decision 9). That is the whole guarantee. It is emphatically **not** "the key is unreadable." A preset is a capability to USE a credential, so any agent that can act on one can obtain or redirect the plaintext:
  - **Read via a spawned child.** `create_agent(envPreset)` puts the real `ANTHROPIC_AUTH_TOKEN` in the child's process env; an `echo $ANTHROPIC_AUTH_TOKEN` in the child, relayed back over `agent://`, returns the plaintext — no REST/MCP read involved.
  - **Exfiltrate via the endpoint.** `update_env_preset` can rewrite the (non-secret, by design) `ANTHROPIC_BASE_URL` to a listener the agent controls, so the next spawn ships the human-entered key in an `Authorization` header to that listener.
  - Also: the write boundary itself is a *convention*, not a wall — agents hold the main server token (for hooks/statusline), so an agent could `curl` the REST secret route directly.

  So env presets assume a **trusted agent fleet** (the personal-tool model): they stop *casual/accidental* key exposure and cross-preset enumeration through the management API, not a *malicious* agent that spawns-with-preset or repoints the endpoint. Hardening those paths (e.g. denying agents the main token, or gating `create_agent(envPreset)` / base-URL edits) is deliberately out of scope; this ADR documents the boundary at its true width rather than claiming a guarantee the design does not back.
- **Polish (silent-failure review):** the server refuses a keyless-preset spawn loudly, but the dashboard's shared `spawnSession` set a status string and *returned* instead of throwing, and that string is only read for the `isBusy` boolean — never rendered. So the feature's headline safety property was loud server-side and silent on screen. Fixed: `spawnSession` now throws on failure (surfacing the reason through `CreateAgentPanel`'s existing error UI); fire-and-forget callers made throw-safe; the preset spawn-refusal classifies as HTTP 400, not 500; and the `PresetsPanel` delete error is surfaced like every other mutation.
- **Alternatives considered and rejected:**
  - *A dedicated `kimi` CLI provider now.* Deferred — unproven status telemetry; the env-override path is officially supported and near-free.
  - *Overload `Template` with the override + secret.* Rejected — mixes a credential into a blueprint type, and templates are read on a different path; a preset is its own concern.
  - *Let agents set the API key via MCP.* Rejected per Terry — humans key it in the UI; agents must not handle or solicit the token.
  - *Store the key in `settings.json`.* Rejected — settings deliberately scrubs `anthropicAuthToken` on read ("a credential must not linger" there); a per-preset 0600 file is the right home, matching the existing auth-token and per-agent-token files.
  - *Seed starter Kimi presets.* Rejected per Terry — keep the collection agent-managed and empty by default.
- **Test evidence — the security-critical logic (`env-presets.test.ts`) was mutation-verified.** Each mutation reintroduces a specific leak and turns its test RED; sources restored afterward:

  | mutation | result |
  |---|---|
  | `maskEnvPreset` returns raw secret values | RED — the mask tests, the UI-create-masks test, the list-masked test |
  | `mergeSecrets` treats a `••••…` round-trip as a real value | RED — "IGNORES a masked round-trip" (would overwrite the real key with its mask) |
  | `resolvePresetEnv` stops stripping reserved keys | RED — "strips a reserved key (defense-in-depth)" |
  | `validateEnvKeys` stops rejecting `DANGEROUS_ENV_KEYS` | RED — the two "code-injection key" tests (injection-time strip is a separate layer that stayed green) |

- **Source:** autonomOS CC session, providers/spawn + dashboard. Investigation and implementation directed by Terry.

## ADR-068: Usage-queue auto-Enter is per-tab AND per-runtime

- **Date:** 2026-08-07 — **Decided by:** Terry (reported that a Codex agent showed the "auto-Enter when limit resets" button while it was CLAUDE usage that was capped; asked for it to be runtime-dependent and per-tab; chose the full per-runtime option — Codex arms against Codex usage — over merely hiding it for non-Claude).
- **Context — the bug.** The usage queue (auto-press Enter in a pane when the usage limit next clears) was written single-account-Claude: `blocked`/`resetsAt` were scalar, the detector polled only `claude-usage`, and the dashboard's `capped` was one account-wide value read by EVERY pane. Arming was already per-pane, but visibility + the fire trigger were global-Claude — so a Codex (or Gemini) pane lit its button whenever the *Claude* account hit 90%, and would have fired on the Claude clear. Per-tab was also nominal: with split panes, every tab showed the same global cap.
- **Decision.**
  1. **Each armed pane carries its agent's `provider`**, resolved server-side from the agent record when the route arms it (the client never asserts the provider). Block state is tracked **per provider** (`Map<Provider, …>`); each `tick` groups armed panes by provider, polls only the providers that have armed panes, and fires each provider's panes on **its own** high→low clear edge. Claude waits on `claude-usage`, Codex on `codex-usage`.
  2. **Gemini (and any runtime with no rolling-window usage source) cannot arm** — there is no probe, so `arm` is a logged no-op and the button never shows. (Gemini's per-token quota has no window to be a % of — see the cut Gemini-usage-bar eval.)
  3. **The queue core is plugin-agnostic.** It reasons over a `NormalizedUsage { windows: {utilization, resetsAt}[]; authError? }`; per-provider adapters (`normalizeClaudeUsage`, `normalizeCodexUsage`) bridge each plugin's snapshot. `createUsageQueue` takes injected `probes` per provider, so tests drive both runtimes with fakes and no network/PTY.
  4. **The route serves per-provider caps.** `GET /api/usage-queue` returns `{ armed, caps: { "claude-code": {capped, resetsAt}, "codex": {…} } }`, computed fresh from each provider's (cached) probe so the button shows before anything is armed. The dashboard's `useUsageQueue(sessionId, provider)` reads ONLY its pane's provider cap; `SessionPane` looks the provider up from the store and passes it to `UsageQueueButton`.
  5. **Per-tab falls out for free.** The button was already one-per-pane (`SessionPane` per `sessionId`); once it reads its own provider's cap instead of a global value, split-screen is correct by construction — each tab shows/arms only when its own runtime is capped.
- **Rationale.** The limit is per-account-per-provider, so a single shared poll per provider (not per pane) is both correct and cheap; the scanners already cache ~60s. Preserving the original design's hard-won invariants — the re-entrancy guard against a double-Enter, the enter≥90/exit<80 hysteresis, the per-pane `seenBlocked` latch, and routing every undeliverable outcome to a notification — mattered more than the shape, so those were kept verbatim and merely keyed per provider.
- **Alternatives considered and rejected:**
  - *Claude-only gate (hide the button on non-Claude panes).* The minimal bug fix, but it leaves Codex agents with no auto-Enter on their own limit. Terry chose the full per-runtime version so Codex benefits too.
  - *Client passes the provider when arming.* Rejected — the server resolves it from the agent record, so a client can't arm a pane against the wrong runtime's limit.
  - *One global detector that fires any armed pane on any clear.* That is the bug.
- **Test evidence — mutation-verified.** Making `arm` ignore the pane's provider (treat every pane as `claude-code`) turns the isolation tests RED — "Claude and Codex panes fire independently" and "a Codex pane fires on the Codex clear edge" — restored green afterward. Plus: "a CLAUDE cap does not block or fire a Codex pane" (the reported bug), the adapter maps, `evaluateCap` on the normalized shape, and the gemini no-op.
- **Source:** autonomOS CC session, usage-queue area. Reported + directed by Terry.
- **Update (2026-08-08, ADR-075 audit):** the Rationale's "the scanners already cache ~60s" is wrong for Claude — its TTL has been **180s** since #264 (`claude-usage/scanner.ts`), predating this ADR. Only Codex caches 60s. Consequence: the watcher's 60s tick re-reads the same Claude cache generation ~3×, which is harmless (cheap cache hits), so the interval stands; the code comment that repeated the 60s claim was corrected in the ADR-075 PR.

## ADR-069: Changeset check is BLOCKING for production-source PRs

- **Date:** 2026-08-08 — **Decided by:** Terry (approved as part of the v0.5.0 release retrospective follow-up; design specified in the task brief, implemented by agent).
- **Context.** The `changeset-check` workflow was advisory-only: it emitted a `::warning` and always passed. Consequence, measured on v0.5.0: **5 substantive PRs (including a breaking change, #284) merged without changesets** and silently slipped the auto-generated changelog; #309 had to backfill them retroactively — which itself triggered a second defect (see the sync-changelog collapse guard shipped alongside this ADR: retroactive changesets all attribute to the PR that added them and dedupe into one line). An advisory nudge demonstrably does not keep the changelog complete.
- **Decision.** `.github/workflows/changeset-check.yml` now **fails (exit 1)** when a PR (a) touches production source under `packages/*/src` — excluding test files (`__tests__/` directories and `*.test.*`, which this repo keeps inside `src/`) — AND (b) adds or modifies no `.changeset/*.md` file (README excluded; deletions don't count, via `--diff-filter=d`). Both signals come from one `git diff --name-only origin/<base>...HEAD` with `core.quotePath=off`. Docs/CI/scripts/test-only PRs never trip the gate and stay frictionless. `bun run changeset --empty` remains the explicit opt-out for source changes with no version impact — an empty changeset is still a file. The `changeset-release/main` bot PR skip is preserved. The job needs no bun install — it is pure git.
- **Rationale.** The obvious detector, `bun changeset status --since=<base>`, was measured first (on `@changesets/cli` 2.31.0, source-read + empirically): its real invariant is **file presence, not per-package coverage** — it exits 1 only when changed packages exist and zero changeset files were added/modified since base; a changeset naming the *wrong* package passes, and so does `--empty`. So the CLI adds no semantic value over checking file presence directly — and it carries a measured **fail-open**: its changed-package detection misses git's C-quoted non-ASCII paths (a PR whose only change is `packages/server/src/café.ts` yields "no packages changed" → exit 0 with no changeset at all). Doing file presence in the gate's own git diff closes that hole and drops the bun setup/install from the job. File presence is sufficient coverage for this repo: every package is in the fixed version group and `sync-changelog` merges ALL package CHANGELOGs, so any non-empty changeset produces a changelog line regardless of which package it names. Fail-closed: `set -euo pipefail`, git runs as a bare command (its failure aborts the step), and only grep's benign no-match exit 1 is forgiven (`|| [ $? -eq 1 ]` — a real grep/redirect error still aborts).
- **Alternatives considered and rejected:**
  - *Keep it advisory, rely on review discipline.* That was the status quo; it failed 5 times in one release cycle.
  - *Gate on `bun changeset status`.* Its exit semantics are file-presence anyway (see Rationale), it costs a bun setup + install per PR, and its changed-package detection has the measured non-ASCII fail-open. Rejected after QA caught the fail-open — the first draft of this gate used it.
  - *Gate on `changeset status` alone (no path filter).* Additionally blocks test-only and config-only PRs — friction the escape hatch would absorb, but at the cost of training people to reflexively add `--empty` changesets, which erodes the signal.
- **Enforcement note.** This workflow is advisory until its job is added to the required status checks on `main`'s ruleset; the `check` job is currently the required one. If the gate proves stable, add it to the ruleset — until then it fails loudly on the PR page, which is still a step up from a `::warning` nobody reads.
- **Source:** v0.5.0 release retrospective (Terry-approved follow-up task); nox's finding on #275 motivated the sibling sync-changelog hardening.

## ADR-070: sync-changelog collapse guard — fail on the retroactive signature, native `pr:` override over a custom marker

- **Date:** 2026-08-08 — **Decided by:** agent (review-driven, on nox's #310 review; escalation to fail aligns with the ADR-069 thesis Terry approved).
- **Context.** nox's finding on #275: `@changesets/changelog-github` attributes a changelog entry to the commit that ADDED the changeset file. N retroactive changesets (documenting old PRs) added in one catch-up PR therefore all carry that PR's number, and `dedupeEntries()` — keyed on PR — folds N documented changes into ONE released line. v0.5.0 lost 4 of 5 backfilled entries this way, silently: the pre-dedup reconciliation compares parsed-entry count to consumed-changeset count, and 5 parsed ≥ 5 consumed passes.
- **Decision.**
  1. **Detection**: pure `findCollapses()` reports every dedupe key carrying >1 DISTINCT changeset body. Distinctness is the signal — the same changeset fanned across several package CHANGELOGs renders byte-identical bullets, so the legitimate multi-package case cannot false-positive. A post-dedup reconciliation (`rendered lines < consumed changesets`) backs it up via the independent git heuristic.
  2. **Reaction thresholds** (`collapseDecision()`): 2 distinct bodies → **warn** (usually a PR that legitimately did two things; blocking a release on that shape is a false positive). ≥3 → **fail the version run** (`exit 1` before writing the root CHANGELOG). Rationale for failing rather than warning: this shape has exactly one known cause, it does not depend on the git-status consumption heuristic (only on parsed CHANGELOG content), and the sibling ADR-069's own evidence is that an advisory warning demonstrably does not change behavior. The failure lands on the push-to-main Version run — visible red, blocks the release PR from advancing until fixed.
  3. **Override**: `SYNC_CHANGELOG_ACCEPT_COLLAPSE=1` downgrades the failure to an annotated warning for the rare legitimate 3+-changeset PR — explicit and logged, never a silent default (per the fail-open lessons in ADR-058/ADR-069).
  4. **Attribution remedy is changelog-github's NATIVE summary override** — a `pr: NNN` line in the changeset body makes it resolve the named PR's real link/sha/author and strip the line (verified in the installed 0.5.2 source; `GITHUB_TOKEN` is already present on the version step). Every warning/error names this remedy.
- **Alternatives considered and rejected:**
  - *A custom `<!-- pr: NNN -->` marker parsed by `sync-changelog`.* Implemented in #310's first draft, then removed: the native override is strictly better — it keeps the correct sha and author (the custom marker had to null the sha, degrading the entry to body-as-title), works on any summary line, self-strips, and needs no parser of ours to maintain. Do not re-introduce a custom marker; if attribution needs change, extend the native mechanism upstream-first.
  - *Warn-only for ≥3.* The v0.5.0 changelog shipped past exactly that class of stderr warning; rejected as thesis-inconsistent.
  - *Fail on 2 as well.* A PR shipping two changesets is a normal authoring pattern here; the cost of wrongly blocking a release exceeds the marginal coverage.
- **Source:** PR #310 review thread (nox), building on the #275 finding; see ADR-069 for the sibling changeset-gate decision.

## ADR-071: ⌘K agent quick-switcher — and terminal-clear moves to ⌘⇧K

- **Date:** 2026-08-09
- **Who decided:** Terry (picked from the domain backlog: "2, yes get it done"), chord-conflict resolution by Shortcuts@autonomOS
- **Context:** mod+1-9 reaches nine sidebar rows and mod+↑/↓ walks sequentially, but Terry's fleets exceed ten agents — name search covers thirty agents in two keystrokes. The registry was built id-keyed so a palette-shaped consumer could exist; this is its first, deliberately scoped to agent switching only (a full command palette stays deferred until wanted).
- **Decision:** `mod+k` opens a type-ahead switcher: fuzzy-ranked live agents (tiers: prefix > word-boundary > substring > subsequence; ties and the empty query follow the sidebar's published row order), Enter/click switches via the row-click path, Escape/backdrop dismisses via the escape stack, focus restores on cancel but goes to the chosen agent's terminal on selection. Candidates are ALL live sessions — including agents hidden by a collapsed hierarchy group, making search the escape hatch the WYSIWYG digit/arrow hints deliberately don't provide. **Conflict resolved: `handleKeyEvent`'s terminal-clear moves from mod+K to mod+⇧K** — the palette idiom (Slack/Linear/VS Code) outranks a convenience that `clear` and ctrl+l still provide; on non-Mac the mod+k reservation steals readline kill-line, recorded in NON_MAC_COST.
- **Alternatives considered:** *mod+P* (VS Code quick-open) — steals browser print, and ctrl+p is readline previous-history on non-Mac; *keep mod+K clear and use mod+⇧K for the switcher* — backwards: the high-frequency action deserves the unshifted idiom chord; *full command palette* — scope Terry hasn't asked for; the switcher's structure (registry-fed list + ranking) is the palette seed if that day comes.
- **Testing:** fuzzy tier/tie unit tests; switcher dom tests (open/focus/stack, filter, Enter/arrow selection, no-match no-op keeps it open, cancel-vs-choose focus behavior); key-policy updates on both platform suites (plain mod+K declined + clear NOT called; ⇧ variant clears); e2e from a real focused terminal (mod+K opens the switcher — the old behavior would have cleared — type-ahead, Enter switches, Escape closes without switching).
- **Source:** autonomOS CC session (Shortcuts@autonomOS), continuation of the ADR-063/066 shortcut initiative.

## ADR-072: Terminal keep-alive cache + coalesced reconnect-replay (agent-switch render efficiency)

- **Date:** 2026-08-08 — **Decided by:** Terry (reported ~5s of "text rushing in from scratch" on every agent switch over a non-great network; approved the two-phase approach and directed it land as a single PR with verified efficiency and latency numbers).
- **Context — two compounding defects.** (1) Dockview re-creates panels on every sidebar agent switch — `syncToActive`'s solo/fromJSON path removes and re-adds panels, which ADR-047 explicitly accepted ("terminals reconnect to their PTY on remount"). `useTerminal`'s unmount cleanup disposed the xterm instance and closed its WebSocket, so a switch rebuilt everything from nothing. (2) The reconnect replay sent the scrollback **one `ws.send()` per stored PTY chunk**: a capped 1MB buffer of Ink-sized chunks fanned into 18,829 frames (L1-measured; 37,075 in-browser for a 2-agent switch scenario). The #253/#260 live-stream coalescer batches by TIME, so it never covered the replay — a replay is an already-complete sequence, not a stream. Net effect: every switch re-streamed ~1MB across ~19k+ tiny WS frames; imperceptible on loopback (~1s), multi-second on a real network.
- **Decision.**
  1. **Replay coalescing (server).** `buildReplayFrames()` packs the buffered chunks into ~64KB frames before `ws.send()` — pure, order-preserving, byte-identical. Default ON; `AUTONOMOS_WS_REPLAY_COALESCE=0` restores per-chunk replay (the ablation baseline), `AUTONOMOS_WS_REPLAY_BYTES` tunes the frame size. Zero added latency by construction: the join is synchronous in the same `onOpen` that already replayed the buffer.
  2. **Keep-alive terminal cache (dashboard).** `terminal/liveTerminals.ts` owns one live terminal per session — xterm instance, scrollback buffer, WebSocket, reconnect loop, touch/scroll/WebGL lifecycle — keyed by sessionId. The React mount only **borrows** it: `acquire()` reparents the cache-owned host `<div>` into the pane, unmount detaches it. Switching back re-attaches the same instance: **0 WS reconnects, 0 frames, 0 bytes re-streamed**. The WS stays open while detached (frames arrive pre-coalesced; a write to a renderer-less terminal is parser-only); WebGL is dropped on detach so hidden terminals hold no GPU context (same discipline the visibility path always used). Cap: 8 live terminals, LRU-on-detached eviction (attached panes are never evicted; over-cap growth is allowed when >8 panes are on screen). Session-end close codes (4010/4004) dispose the entry, so dead sessions can't hold a slot or a reconnect loop.
- **Measured (L1 Node harness + L2 Playwright through the real dashboard, same build, flag-ablated).** Switch back to a 1MB-scrollback agent: baseline 1 reconnect / 37,075 frames / 1024KB / settled 965ms (loopback) → replay-coalescing-only 1 / 16 / 1024KB / 412ms → keep-alive **0 / 0 / 0KB / 44ms**. L1 replay: 18,829 frames → 9-16 (size-dependent), drain 78ms → 18ms. The flag-off path is byte-identical to old main (18,829 frames), so the A/B is trustworthy. The L2 switch spec includes a non-blank pixel guard — a keep-alive bug that reparented a blank terminal would otherwise produce the same perfect zeros.
- **Rationale.** The dockview layer is untouched — panels still tear down and re-mount; the remount just became cheap. That keeps the risk inside two files (the cache module + the thin hook) instead of changing layout-engine semantics, and it fixes workspace `fromJSON` re-creation by the same mechanism. Phase 1 stays valuable independently: it covers cache-miss reconnects (LRU eviction, page reload, >8 agents) and any future client.
- **Alternatives considered and rejected:**
  - *Keep dockview panels mounted across arrangement switches.* Changes the layout engine's topology semantics (ADR-047's overlay model) for the same user-visible result; far larger blast radius than caching the terminal below it.
  - *Server-side rendered-screen snapshot (headless xterm + serialize addon) instead of raw replay.* Cuts replay bytes further (~KB instead of ~MB) but adds a server-side terminal emulator per session and a new protocol; the keep-alive cache makes warm switches free anyway, and coalesced replay makes cold ones acceptable. Revisit only if cold-attach over slow links still hurts.
  - *Replay via the existing time-based live coalescer.* Wrong tool — it would add its flush window to a burst that is already complete; the pure join has no window to wait for.
- **Hardening the cache forced (post-review).** Making the terminal immortal promoted two inherited, transient reconnect quirks into standing corruption, so both are fixed rather than caveated: (1) the server replays the FULL buffer on every connect, so a REconnect (sleep/wake, blip, server restart) would have appended a duplicate copy of history to the retained buffer — `terminal.reset()` now runs on every reconnect (never the first connect) before the replay lands; (2) a superseded socket's late `onclose` could arm a reconnect timer that closes the healthy replacement in a permanent ~1s churn loop — every WS handler now no-ops unless its socket is still `wsRef.current`. Additionally: session-end (4010/4004) frees the cache slot FIRST (a throw in the store routing can no longer leave a zombie entry) but defers xterm disposal until the pane's detach, so the final output stays visible until dockview prunes the dead panel; `detach(container)` is ownership-checked so a stale mount's cleanup cannot blank a newer mount; a constructor failure rolls back its own listeners/socket (the entry never enters the cache, so dispose would be unreachable); and a detached terminal's endless reconnect logs a breadcrumb every 10 consecutive drops.
- **Honest caveats.** A detached-but-cached busy agent still costs client parser CPU for its live frames (bounded by the 8ms server-side coalescing; renderer work is zero while hidden). Memory is ~8 × 10k-line scrollback buffers. The server holds one PTY→WS forwarder per cached terminal — 8 sockets instead of 1; the per-socket coalescer already existed. `AUTONOMOS_WS_REPLAY_COALESCE=0` exists solely for ablation, not as a supported mode.
- **Perf-harness security boundary.** The L2 rig needs an auth-free loopback server; that is `AUTONOMOS_PERF=1`, decided once at boot, which mounts `/api/perf` (dynamic import — FakePty/ink-burst stay out of the production eager import graph) and swaps the PUBLIC listener's auth for a pass-through. It refuses to engage unless the resolved bind host is loopback (an unauthenticated `POST /api/agents` on a LAN bind is remote code execution, not a benchmark convenience), warns loudly either way, never touches the internal socket's auth (`/mcp`, gateway), and is stripped from spawned agents' env so a child server can't inherit the bypass.
- **Test evidence.** Ablation harnesses above; 13 dom tests pin the cache lifecycle (detach does NOT dispose/close — the core fix asserted in the negative; LRU evicts first-detached only, never attached; 4010 while attached frees the slot but keeps the final output until detach, while detached disposes immediately; reconnect resets before the replay; a superseded socket's late close cannot start churn; a stale mount cannot detach a newer mount; network-blip close keeps the entry and reconnects; failed backend caches nothing); 6 unit tests pin `buildReplayFrames` (byte-identity, order, oversized chunk, empty buffer, flag-off passthrough). Server suite 812/812, dashboard 372/372 green.
- **Source:** autonomOS CC session (TerminalRender agent), approved by Terry via TeamLead relay 2026-08-08.

## ADR-073 — Escalating probe + retractable warnings for the channel-server registration check

- **Date:** 2026-08-08
- **Who decided:** Terry (picked "fix everything" from the notifications/warnings audit); design by NotificationsAudit@autonomOS
- **Context:** The 2026-08-08 audit of the live install (docs/research/notifications-warnings-audit.md) found the notification panel 100% saturated with false SystemWarnings. The largest class (23 of 33) was the channel-server registration check: a ONE-SHOT probe 30s after spawn that declared "can't send messages — outbound unavailable" for the entire resumed fleet on every restart-all, because a boot sweep routinely takes Claude Code past 30s to launch its MCP subprocess. The live log showed "never registered within 30000ms" followed seconds later by the same agent's gateway connect. The warning's own premise (operators act on it) makes a false one actively harmful.
- **Decision:** Two coupled changes. (1) The check probes on an escalating schedule (30s/90s/180s cumulative, `CHANNEL_SERVER_PROBE_DELAYS_MS`) and warns only on the FINAL miss; logic extracted to a leaf module (`agents/channelServerCheck.ts`, promptDelivery-style injected IO) so the schedule is unit-testable. (2) Operator-facing SystemWarnings became RETRACTABLE: `pushSystemNotification` now returns a server-minted id, `retractSystemNotification(sessionId, id)` splices it, and the gateway's registration edge (`registerSessionClient` → `noteChannelServerRegistered`) retracts a warning that a late registration proves premature, logging the correction. Unretracted warnings are carried across a re-arm (respawn) so the replacement spawn's success clears them.
- **Rationale:** The one-shot design measured TUI boot latency, not failure; only the final state of an escalating schedule is evidence of anything. Retraction exists because the check can still be wrong at 180s under extreme load — and a stale warning the operator investigates costs more than the warning saves. Warning-on-final-miss (not silence) preserves the true-positive: a channel server that genuinely never launches still warns, pinned by tests in both directions plus seam tests that fail if the router wiring or the store splice is removed.
- **Alternatives considered:** Longer one-shot grace (still a guess; any fixed point loses to a slower boot, and a missed genuine failure would then take even longer to surface); scaling grace with fleet size (proxy for the same guess); warning suppression during boot sweeps only (leaves the same false alarm on any individually slow spawn); edge-triggered warn on unregister (out of scope — see the module header's drop-after-register gap note).
- **Source:** notifications/warnings audit session (NotificationsAudit@autonomOS), Terry's "let's get everything fixed" pick, /polish findings (silent-failure-hunter M2 drove the carry-across-re-arm; code-reviewer drove the seam tests and this ADR).

## ADR-074 — Settle-gated prompt-delivery receipt with retractable give-up

- **Date:** 2026-08-08
- **Who decided:** Terry (picked "fix everything" from the notifications/warnings audit); design by NotificationsAudit@autonomOS
- **Context:** The prompt-delivery receipt (spawn → SessionStart → UserPromptSubmit, re-deliver on miss) used fixed windows anchored to spawn/SessionStart: 15s for SessionStart, 20s for UserPromptSubmit, 20s more before "giving up". The 2026-08-08 live-install audit proved those windows measure Claude Code TUI boot latency, not delivery: under a 6-worker concurrent spawn every agent took >40s from SessionStart to prompt submit, so every spawn produced the full false-warning ladder ("likely dropped" → paste → "re-delivery failed, needs a manual nudge") — 10 of the 33 live panel notifications. Worse, the audit agent itself received its brief TWICE: the paste + Enter queued in the PTY buffer behind the booting TUI alongside the original argv prompt, and both submitted ("double-submission is worse than a manual nudge" is the module's own design rule, and it was happening on every slow boot). The mechanism does catch real drops (one observed case where re-delivery was confirmed), so it must be tuned, not deleted.
- **Decision:** (1) SETTLE-GATE the windows: no receipt window arms until the provider's startup watcher reports the startup dialogs terminal (`attachStartupWatcher` gains an `onSettled` callback fired exactly once from the watcher's single cleanup path — all-settled, give-up, hard timeout, or PTY death); spawns without a watcher settle immediately; a 45s in-module fallback self-settles so a wiring regression can never silently disable the detector. (2) Widen the windows to what they actually measure: 30s (settle→SessionStart, the trust dialog gates session creation itself) and 90s (→UserPromptSubmit; the argv prompt submits at input-attach, which is TUI+plugin boot time). (3) Make giving up RETRACTABLE: the tracker parks as `given_up` (10min retention) instead of finishing; a late receipt retracts the failure SystemWarnings via the ADR-073 retraction API and logs the correction. The factual "prompt was re-delivered" note is never retracted.
- **Rationale:** The dominant false-positive cause was window-start, not window-length — every observed "failure" was a prompt that submitted fine once the TUI attached. Settle-gating removes the auto-trust phase from the measurement; the 90s width covers the observed >40s attach tail with margin while still recovering a genuinely dropped prompt in ~1.5min (vs 20s before — an acceptable trade against a guaranteed duplicate brief on slow boots, which costs a full duplicated turn plus operator confusion). Retraction exists because any fixed window can still lose to a pathological boot; the residual double-submit window (paste while TUI unattached for >90s post-settle) is documented and accepted.
- **Alternatives considered:** Deleting re-delivery (loses the real-drop recovery the audit confirmed); positive TUI-ready detection via PTY output needles (fragile across CC versions — auto-trust needles already miss redraws); pausing clocks during usage-cap dialogs only (doesn't cover plugin/MCP boot latency, the measured dominant term); delivering the prompt via paste-only after settle instead of argv (changes the primary delivery path to fix the fallback — larger blast radius, and argv delivery works in the fast-boot common case).
- **Source:** notifications/warnings audit (docs/research/notifications-warnings-audit.md) + this session's self-referential evidence (the audit agent's own panel entries and double-received brief); builds on ADR-057 (capability gate) and ADR-073 (retractable warnings).

## ADR-075: Usage correctness — the auto-detect toggle selects the credential source, and the bar and queue share one window set

- **Date:** 2026-08-08 — **Decided by:** Human (Terry — reported both defects and approved the fixes as "PR 0" of the API-consolidation initiative), implemented by APIConsolidation@autonomOS.
- **Context.** Two operator-reported defects with one audit behind them (see `docs/research/api-consolidation-audit.md`, Part 4):
  1. **The status bar and the usage-queue button contradicted each other** (bar "5h 87%" while the queue button armed at 90%). Traced: both read the SAME scanner cache — they cannot disagree on a value — but they projected different *window sets*. The bar rendered only `fiveHour`+`sevenDay`; the queue capped on `max()` over four windows including the per-model weeklies (`sevenDaySonnet`/`sevenDayOpus`; Codex: every `additionalLimits[]` entry). A Sonnet weekly ≥90% armed the button while the bar truthfully showed lower headline numbers.
  2. **Turning auto-detect ON did nothing while a manual session key was saved.** `getRateLimits()` consulted the manual key first, unconditionally; the `autoDetectClaudeAccount` toggle was only read after a key-miss — a setting that could disable the fallback but never displace the override. After a `claude` account switch, usage silently kept tracking the OLD account (reversal of ADR-048's "manual override always wins", which baked the trap in).
- **Decision.**
  1. **One labeled window set.** `NormalizedWindow` carries a `label`; `evaluateCap`/the watcher report WHICH window is capping (`CapStatus.window`), the queue button names it ("Sonnet 7d at limit — type to queue"), and the status bars render a third chip whenever a non-headline window (per-model weekly / Codex named limit) exceeds both headline numbers. Bar and button can no longer appear to disagree: anything that can arm the button is visible on the bar.
  2. **The auto-detect toggle SELECTS the source.** ON → Claude Code's OAuth login is authoritative; a saved key is only a fallback when the OAuth credential itself is broken (missing/stale/unauthorized — transient failures deliberately do NOT fall back, to avoid flapping between two accounts' numbers). OFF → the saved key is authoritative. Pasting a key flips the toggle OFF in the same settings write (pasting = explicit intent to use that key; it also keeps save-then-validate honest, since validation reads whatever source is active).
  3. **Honest staleness + herd control**, folded in from the same audit: last-good snapshots re-served during upstream failures now carry `error`/`errorKind` (bar shows numbers + a warning glyph instead of a silent frozen value or a blanked "–"; `fetchedAt` is never restamped), both scanners single-flight concurrent cache-missing reads (the status-bar poll and the queue's cap read × N tabs stampeded the shared endpoints at TTL boundaries, courting the 429 that pins the display for 5 minutes), and Claude's `stale_token` joined the queue's credential-error set (an expired token warned Codex panes but left Claude panes holding silently).
- **Alternatives considered:**
  - *Make the bar compute the same `max()` as the queue and show one number.* Rejected: the headline 5h/7d numbers are what users track day-to-day; collapsing to one max hides which budget is burning.
  - *On enabling auto-detect, clear the saved key.* Rejected: destroys a credential the user may want to fall back to; the toggle round-trips instead.
  - *Keep manual-key precedence and have the toggle clear the key.* Same destruction problem, and it leaves ADR-048's trap for the env-var key.
- **Compatibility:** `POST /api/usage-queue` responses gain `caps[provider].window` (additive); settings shape unchanged. ADR-048's read-only credential contract is untouched — this changes *which* credential is chosen, never how it is handled.
- **Source:** Terry's direct reports in the APIConsolidation session (87%-vs-90% observation; account-switch annoyance), traced by a dedicated audit agent; fixes approved as the quick-correctness slice ahead of the usage-to-push work (PR 5 of the staged plan).
## ADR-076: Escape protects popover drafts; the terminal keymap becomes data

- **Date:** 2026-08-09
- **Who decided:** Terry (approved the debt batch: "get 2 and 3 both done"), design by Shortcuts@autonomOS
- **Context:** Two items ADR-065 flagged-not-fixed. (1) Escape typed inside a popover's text field closed the popover and discarded the draft — with the registry's capture-phase `ui.dismiss` this became the only rough edge in the Escape story. (2) xterm's `handleKeyEvent` mod-switch (clear/select-all/readline sends/the mod+W decline) was the last hand-list outside the registry's one-table discipline.
- **Decision:** (1) `ShortcutDef.run` receives the triggering event; `ui.dismiss` blurs an editable target in a LIGHTWEIGHT popover (status-bar settings/usage/env-var panels) instead of closing — draft intact, popover stays; second Escape closes. Excluded: xterm's helper textarea (terminal Escape stays single-press) AND modal dialogs (`role="dialog"`: the help overlay and the ⌘K quick-switcher), which close on Escape from their own input — their query is not a draft, and the palette's key handlers live on that input, so blur-instead-of-close would strand it open-but-inert (review catch, e2e-verified). (2) The mod-switch becomes `shortcuts/terminalKeymap.ts`: a data table of `{key (printed, lowercased), shift: required|forbidden|any, action, why}` consumed by `handleKeyEvent` — the shift tri-state preserves the old switch's raw-key semantics (named keys matched under shift; letters did not), pinned by the existing two-platform key-policy suites plus a table drift test — with ONE intentional divergence (review catch): under CapsLock+no-Shift the lowercasing fires the `forbidden` letter entries where the old raw-key switch fell through to xterm; the more consistent behavior, pinned as a decision (no duplicate overlapping bindings, every entry documents its why). (3) The help overlay traps Tab like the palette (aria-modal was claimable-out before).
- **Alternatives considered:** *`skipWhenEditing` on `ui.dismiss`* — would leave Escape doing NOTHING in a popover field (the bubble listeners it replaced are gone); blur-then-close is strictly better. *Registry entries for the terminal bindings* — wrong scope: they need the live terminal/socket, so they stay terminal-side but adopt the registry's documentation discipline.
- **Source:** autonomOS CC session (Shortcuts@autonomOS), closing ADR-065's flagged list.

## ADR-077: Release rollout mechanism — dual-mode updater with a recorded install marker

- **Date:** 2026-08-08 — **Decided by:** Terry (chose dual-mode over converge-on-artifact after commissioning an adversarial two-advocate debate + a 13-peer market survey; the final shape synthesizes both). Implemented by ReleaseRollout agent.
- **Context.** Updating autonomOS was `git pull` + `make prod`. An `autonomos upgrade` command already existed (#170: fetch latest release → SHA256 verify → atomic swap → `.previous`), but it was structurally unreachable on every real install: it detected upgradeability by string-matching its own path for `*/share/autonomos`, while all real deployments are source-mode (`make prod` → tsx wrapper). It had zero tests, and the vended tarball path had never run outside CI. Two distribution paths (tarball `install.sh` vs rsync-source `make deploy`) never converged — ADR-043 earmarked "one versioned artifact for both" and it never happened. Additional audit findings: `make deploy` rsyncs with `--exclude .git`, so production boxes are not even git clones (no provenance — an uncommitted revert once shipped silently); `install.sh` re-run on a live box overlay-extracted then failed; no `--version`, no rollback command, no update surface anywhere.
- **Decision.**
  1. **Two install modes, recorded — never sniffed.** `install.json` is written into the bundle dir at install time and rewritten into the new bundle on every upgrade; `resolveInstall()` trusts the marker, falls back to an explicit legacy arm (`<prefix>/share/autonomos` without a marker = bundle mode, for pre-marker installs), and REFUSES anything else with instructions. Path-sniffing an install shape is the failure class behind Claude Code #28625 (native install misdetected as npm → symlink deleted) and most of Gemini CLI's updater bugs (success reported while the old binary kept running): a self-updater that guesses wrong is worse than none.
  2. **Bundle mode (external users): the #170 machinery, fixed and tested.** Target-version pinning (`upgrade --version=X.Y.Z`, downgrades explicit and loud; `VERSION=` pin on install.sh), an unknown-version refusal (a corrupt version file parsed as 0.0.0 and sailed through the semver gate), stage-and-swap in install.sh (extraction over a live bundle accumulated deleted files forever and made the documented re-curl "upgrade" fail), `autonomos rollback` (symmetric `.previous` swap), `--version`.
  3. **Source mode (Terry's boxes): a managed git clone pinned to release tags** — ships in the NEXT PR; the marker schema, the mode's resolution, and its refusal messages ship now. Chosen over converging everything on the artifact because legibility of the runtime to its own agents is product identity for a self-hosting agent platform (the two closest peer products — Codeman and amux, both Claude-Code orchestrators — ship source-legible git installs with self-update), and because the no-git-on-prod finding meant BOTH options required a one-time migration, erasing convergence's "no migration" edge. Requirements that convert the incident history into design: tag pinning (not `git pull main`), dirty-tree refusal, and rebuild + immediate restart.
  4. **The process is never the agent of its own restart (stage-then-exit).** The CLI (out-of-process) asks the supervisor to cycle the daemon and then health-gates: polls the pid file (the NEW server writes its version on listen — a real boot watermark needing no auth) plus an HTTP probe, and AUTOMATICALLY rolls back + restarts if the new version doesn't come up. The in-process REST path does the swap, responds, and `exit(0)`s — it never calls `launchctl`/`systemctl` on itself (OpenClaw #85120/#85246: in-band updates die with their process tree; no-op updates must not restart). Exit only on status `upgraded`.
  5. **The supervisor never gives up: `StartLimitIntervalSec=0`** on the systemd unit. With the default burst, a bundle that crashes on boot exhausts the limit and `Restart=always` silently becomes permanent downtime — the single highest-value operational finding of the survey.
  6. **Update visibility (next PRs): server-side cached check, passive badge, NO dashboard update button in v1.** The dashboard never calls GitHub; the server checks on a slow cadence and exposes additive fields on `GET /api/system/version` (`latest`, `updateAvailable`, `checkedAt` — path and existing fields frozen, contract agreed with the API-conventions pass). The in-band path's missing health gate is exactly why the button waits.
  7. **Verb: `upgrade`** (the shipped name), with `update` as an alias.
- **Rationale.** The pattern is Claude Code's installer (versioned artifact + verified checksums + pin-at-install) fused with Hermes/Codeman's source legibility, under the one law every surveyed self-updating product obeys: the actor performing the destructive step is outside the process being replaced (HA Supervisor re-points a tag and exits; Coolify detaches a helper; Electron applies on next start). Recording the mode kills the deriveBundleDir string-match class. Testing the tarball path first is sequencing, not preference — it exists, external users need it regardless of Decision A, and it's the simpler proving ground for the shared spine (health gate, rollback, marker) that source mode reuses.
- **Alternatives considered and rejected:**
  - *A1 — converge everything on the vended artifact* (incl. Terry's boxes). One artifact, one test surface, strong provenance — but the artifact is a minified bundle (illegible to the agents that develop the platform), the migration-cost edge evaporated with the no-git-on-prod finding, and the maintainer would never run the install shape contributors actually use.
  - *Keep rsync `make deploy` as a third supported mode.* No analogue in any surveyed product; n8n and Home Assistant both culled install modes citing support burden. It stays as a private dev tool only; the updater will never detect or handle it.
  - *Sniff `.git` / path shape instead of a marker.* The Gemini-CLI graveyard. A tarball unpacked inside a repo, or a checkout with `.git` pruned, both misclassify.
  - *Dashboard update button now.* OpenClaw's most-reported update bugs are all dashboard-side; without an out-of-process helper the button can only do the ungated in-band path.
  - *`versions/<v>` directory keep-N scheme (Claude Code/Zulip).* Deferred, `.previous` suffices for one-cycle rollback; the symlink-farm layout can layer on later without changing the marker or the commands.
- **Test evidence.** 26 unit tests: `resolveInstall` (marker/legacy/refusal arms), `performUpgrade` against a local release-API fixture serving real tarballs (happy path, up-to-date, ahead-of-release guard, explicit downgrade, missing tag, checksum mismatch leaves live bundle untouched, missing asset, unknown-version refusal), `performRollback` symmetry. `scripts/test-install.sh` gains a hermetic e2e upgrade→rollback cycle (fake v9.9.9 release over local HTTP) — and, after the 2026-08-08 incident where its pre-existing `stop` step booted out the operator's REAL daemon (service lookups resolve against `$HOME`), the script now isolates `HOME` for every post-build step and asserts after each service-touching step that the real daemon is still loaded (restore-then-fail on violation).
- **Source:** autonomOS CC session (ReleaseRollout agent): audit + OpenClaw/Hermes research + A1-vs-A2 advocate debate + 13-peer market survey, all relayed through TeamLead; Terry picked the approach directly in-session.


## ADR-078: API conventions for the dashboard/gateway consolidation — and the first dead-surface removals

- **Date:** 2026-08-09 — **Decided by:** Human (Terry approved the target design + staged plan 2026-08-08, propose-pause; audit in `docs/research/api-consolidation-audit.md`), implemented by APIConsolidation@autonomOS. This entry records the CONVENTIONS the remaining slices implement (PRs 2–6 of the staged plan) plus what PR 1 removed. Each later slice cites this entry rather than re-deciding.
- **Context.** The audit mapped 48 public REST endpoints, 3 WS channels, and 2 MCP transports and found systemic divergence: seven error-envelope shapes, creates split between 200/201, zero request validation on REST while HTTP MCP Zod-validates the same operations (and the channel MCP path — the one every spawned agent uses — validates nothing), three agent resolvers with different duplicate-name behavior, four WS envelope conventions, and a dashboard with 45 raw `fetch()` sites and no client layer. Also a stratum of dead surface: endpoints, WS client types, and message fields with no callers.
- **Decision — the conventions (target state, implemented incrementally):**
  1. **Error envelope.** One shape for every non-2xx: `{ error: string, code?: string, retryable?: boolean, details?: object }` — the shape `agents.ts`' `onError` already emits, promoted to `app.onError` + `app.notFound` on BOTH listeners (uniform JSON 404s in dev and prod). Typed `Error` subclasses replace substring-sniffing thrown messages for status mapping. Extra fields (`currentVersion`, `children`, rollback detail) move under `details`.
  2. **Success conventions.** Mutations return the resource; pure actions return `{ ok: true, ... }`; creates return **201**; input that is accepted but ignored always reports a `warnings: string[]` (the templates router's pattern, generalized — a 200 that silently dropped half the request is how callers come to believe things that aren't true).
  3. **One validation source.** Zod schemas per operation live in one shared server module, consumed by REST (validator middleware), the HTTP MCP server, and the channel server (validate before dispatch); the MCP tool JSON-Schemas are GENERATED from the Zod source so tool-schema ↔ REST-schema drift becomes structurally impossible. The module stays inside `packages/server/src` and bundles into the channel server (which must not import `@autonomos/core`).
  4. **One resolver.** Agent lookup is id-or-name with duplicate-name ambiguity detection (today's `resolveAgentId` semantics) everywhere an agent is addressed — REST, both MCPs, usage-queue.
  5. **Optimistic concurrency** is a `version` field in the body; the `If-Match` header variant is retired (its only carrier, `PATCH /api/agents/:id`, was dead and is removed below).
  6. **Paths.** Everything REST under `/api`; resources are plural kebab-case nouns; actions are `POST /api/<resource>/:id/<verb>`. Renames land in the staged rename slice BEHIND one-release compat aliases (running agents' channel-servers proxy old paths until respawn): `/auth` → `/api/auth`, `/api/scheduler/*` → `/api/schedules/{status,settings}` (schedule names `status|settings|runs` become reserved), hooks-READ family → `/api/agent-status` + `/api/notifications`. Hook INGEST keeps `/api/hooks/:sessionId` on the internal socket — baked into running agents' settings.
  7. **WS envelopes** (new channels + `/ws/agents`; the terminal channel's protocol is owned by the terminal-perf work and untouched): `type`-discriminated, dotted past-tense event names, flat payload, a `ts` timestamp on every frame.
  8. **`/api/system/version` seam (agreed with ReleaseRollout, 2026-08-08):** path stable; `{version, platform, arch}` preserved byte-for-byte; badge fields `{latest: string|null, updateAvailable: boolean, checkedAt: string|null, installMode: "bundle"|"source"|null}` are additive; the endpoint stays fast and always-200 (it doubles as the pid-file liveness probe, which treats any HTTP response as alive) — the GitHub check behind it is cached, off-request, serve-last-known. `/api/system/*` is the rollout initiative's lane; the consolidation does not touch it.
- **Decision — PR 1 removals (all verified caller-less in the audit):**
  - `dashboard_connect` / `dashboardClients` / `fanOutToDashboard`: unreachable by construction since ADR-055 moved `/ws/gateway` onto the Unix socket (a browser cannot dial `ws+unix://`), yet the fan-out still ran per routed message. A dashboard message feed, if built, gets a public `/ws` endpoint.
  - `GET /api/hooks/:sessionId/status` and `GET /api/hooks/:sessionId/notifications`: no first-party caller (dashboard uses the bulk reads); the status single also never 404'd — an unknown id returned the `DEFAULT_AGENT_STATE` sentinel, indistinguishable from a real idle agent.
  - `PATCH /api/agents/:id`: zero callers, zero tests, and the surface's only `If-Match` concurrency carrier (Terry: delete as dead; a dashboard rename/reparent UI is a future feature, not consolidation).
  - `GatewayMessage.platform` (hardcoded `"slack"` on every agent message) + `platformMessageId` + the `Platform` type: the last ADR-064 adapter vestiges; receivers read `userName`/`fromUri`/`text`/`timestamp` only.
  - **Fixed alongside:** hook state is now reclaimed on agent DELETE (`clearAgentState`/`clearNotifications` previously had no production caller, so `GET /api/hooks` returned ids nothing could resolve, forever; KILL deliberately keeps state — the record survives); the scheduler's sender renders as "Scheduler" instead of the sliced pseudo-UUID "Agent schedule".
  - **Correction to ADR-055 (credential revocation sites) — review-driven, decided by agent (APIConsolidation), verified by independent probe.** ADR-055 recorded the per-agent token as "revoked at the `markExited` chokepoint". That is now incomplete: **deletion revokes too, inside `deleteAgentRaw`** — the single store chokepoint every delete path funnels through (mirroring `markExited` for the exit paths). The extra site is load-bearing, not belt-and-braces: the dying process fires its final hook curls (SessionEnd, Stop) AFTER the record is gone, and `markExited`'s not-found early-return means ITS revoke never runs on the delete path — with the token still valid, a straggler ingest passed verification and re-grew a status entry no store lookup could resolve, reintroducing the exact leak the reclamation closes, on the most common path (deleting a running agent). The exit-handler's crash/adopt notifications are existence-guarded for the same reason (they run async after a possible DELETE). **Rule going forward: credential revocation belongs at every path that ends an agent's existence** — a new removal path must revoke, and reviewers should check it does. The DELETE route additionally revokes at its confirm point: on the wasLive-only path (live PTY, record already gone from the store) `deleteAgentRaw`'s not-found guard returns before its revoke, so the chokepoint alone does not cover it. The same invariant has a sibling beyond hook state: the DELETE route also DISARMS any queued usage-queue auto-Enter, which would otherwise fire hours later against a gone PTY and notify under an unresolvable id.
- **Alternatives considered:** *Big-bang refactor* — rejected up front by Terry (staged PRs, each behind his visual-QA gate). *Keeping the dead surface "because it's built"* — rejected; the audit showed dead-but-plausible code repeatedly misleading readers (the fan-out comment had to actively warn it reached nobody). *Wire `PATCH /api/agents/:id` to a new dashboard UI instead of deleting* — proposed, Terry chose deletion; re-add with the body-`version` convention when a real consumer exists.
- **Supersede/state notes:** This entry supersedes ADR-055's listing of the per-session hooks reads as live surface, and CLOSES ADR-061's second permission-mode drift vector (the unvalidated `PATCH /api/agents/:id` it named is deleted). `patchAgent`'s `expectedVersion` parameter is retained despite its last HTTP caller's removal — it is the implementation seam for the body-`version` concurrency convention above (PR 2+). `routes/hooks.ts` doubling as the hook-state store (four non-route importers) is acknowledged tech debt; extracting an `agentState.ts` module is queued for a later consolidation slice.
- **Source:** APIConsolidation@autonomOS session; audit + staged plan approved by Terry 2026-08-08 (propose-pause), PR 0 = ADR-075. The number of THIS entry is renumber-at-merge if another initiative lands first; runtime strings deliberately do not cite it.

## ADR-079: Source-mode upgrades — managed-clone mechanics (implements ADR-077 §3)

- **Date:** 2026-08-10 — **Decided by:** design per ADR-077 (Terry-approved); mechanics decided in implementation + two review rounds (nox, silent-failure + code-review agents) on PR #321. Provisional number — renumber to next-free at merge per the collision convention.
- **Context.** ADR-077 §3 committed to a source install shape ("a managed git clone pinned to release tags — ships in the NEXT PR") but left the mechanics open. This entry records the decisions that PR made, several of which exist only because reviews caught their absence.
- **Decision.**
  1. **Marker at the repo ROOT, found by a bounded upward walk (10 levels), source-mode markers only.** The entry script runs from `packages/cli/src/`; writing the marker next to it would dirty the very tree the upgrade requires clean. A bundle-mode marker in a parent is a misconfiguration and never accepted. `install.json` is gitignored so the updater's own bookkeeping can't trip its dirty-tree refusal, and the marker write is atomic (temp + rename) because in source mode `previousRef` in that file is the ONLY rollback record.
  2. **`install.bundleDir` (where the walk physically found the marker) is ground truth for all git/filesystem operations**; the marker's `prefix` field is install-time display metadata (goes stale on relative paths / moved clones).
  3. **Build-regenerated tracked artifacts are exempt from the dirty-tree refusal by named list** (`BUILD_MUTATED_TRACKED_FILES`: `channel-server/dist.mjs`, `bun.lock`) and restored to committed state before every dirty check AND before the failed-build revert checkout — `make build` rewrites them in place, so without the exemption the updater's own build dirties the tree and every later run (including the revert of a failed build) refuses on its own byproducts. Resets are logged when they discard drift; a sync-guard test ties the list to the Makefile build target.
  4. **A failed build reverts the checkout AND rebuilds at the reverted commit.** `make build` destroys gitignored artifacts (`rm -rf _embedded_dashboard`, vite emptying `dashboard/dist`) before regenerating them; a git-only revert restores source but not artifacts, so "returned to previous commit" would silently leave the next daemon respawn without a dashboard build. Both build outcomes are reported honestly.
  5. **`make build` factored out of `make prod`** (deps + channel-server + dashboard, zero service operations) — the updater owns the restart, out-of-process and health-gated, reusing the ADR-077 spine unchanged. `make deploy` is deprecated to a dev tool with a printed warning; `scripts/install-source.sh` (clone-or-adopt at an existing `vX.Y.Z` tag only — an explicit branch ref is refused, that's the shape this mode replaces) is the supported path and is documented in the README.
  6. **Spawned git runs under an allowlist-scrubbed environment** (`GIT_*` stripped except network/auth plumbing; `GIT_TERMINAL_PROMPT=0`): inherited `GIT_DIR` inside hooks redirected fixture git at the real repository and flipped `core.bare` on the shared `.git`, breaking every worktree — the incident that proved denylists insufficient here.
- **Known limitations (recorded, not hidden):** upgrades never re-render the supervisor unit or the `.autonomos-bin` wrapper in source mode (a unit-template change like ADR-077's `StartLimitIntervalSec=0` reaches source installs only via a re-run of the installer) — surfaced to Terry as an open follow-up; the source flow has no concurrency latch (bundle's REST latch doesn't apply — the REST path refuses source upgrades outright since the in-process request can neither afford a minutes-long rebuild nor get a health gate); prerelease tags compare equal to their release (unreachable via `releases/latest`, documented in code).
- **Source:** PR #321 review threads (nox: artifact-drift refusal loop, prefix-vs-bundleDir, `--ref` branch loophole) + silent-failure and code-review agent reports (revert-artifact gap, marker-write guards, env allowlist), autonomOS CC session (ReleaseRollout agent).

## ADR-080: Idempotent supervisor-unit sync on upgrade — drift-detect, preserve install-time parameters, zero extra restarts

- **Date:** 2026-08-10 — **Decided by:** Terry (ruling relayed via TeamLead: "ship idempotent re-install", with the explicit bar that idempotent means *no-op when nothing changed*, not *always re-run the installer*). Mechanics decided in implementation. Provisional number — renumber to next-free at merge per the collision convention.
- **Context.** ADR-079's known limitation: upgrades never re-rendered the supervisor unit, so a unit-template fix (e.g. ADR-077's `StartLimitIntervalSec=0`) shipped in every release yet never reached an existing install without a manual installer re-run. Naively re-running `install-service --force` inside `upgrade` was rejected for two verified hazards: (a) **flag loss** — the installer bakes `--port`/`--host` from its own argv and `install.json` records neither, so a blind re-render silently resets a forge-shape `:3100` install to the default port on its next upgrade (bundle-mode `install.sh` already greps the old unit for `KEPT_PORT`/`KEPT_HOST` before its `--force` re-run; that recovery lived only in shell, and source mode had nothing); (b) **restart composition** — the installer's activation path unconditionally bounces the daemon and runs its own verifier, fighting the upgrade's health-gate + auto-rollback machinery.
- **Decision.**
  1. **Recover, render, byte-compare** (`cli/lib/service-sync.ts`): parse the INSTALLED unit to recover everything install-time-variable — program argv (bundle bin or `.autonomos-bin` wrapper, `--port`/`--host`), baked `HOME`/`PATH`, log dir — render the current template around those recovered parameters, and byte-compare. Identical → nothing written, no supervisor command, nothing printed. Rendering from the current process env instead would flip `PATH`/port on any upgrade run from a different shell — the exact drift class this feature exists to prevent (and `PATH` order has already caused a node-ABI incident on this project once).
  2. **Unparseable → hands off.** Any unit whose parameters can't be fully recovered is skipped with a warning and manual instructions, never guessed at; a sync failure never blocks the upgrade (the daemon keeps running under the unit that was good enough yesterday). Corollary: a *hand-edited but parseable* unit reads as drift and is healed back to the template — that self-healing is the point of the ruling ("deployed shape always matches the template").
  3. **Zero extra restarts, by sequencing.** Sync runs between swap/build and the upgrade's one existing health-gated restart, so a drift heal is applied by a restart that was happening anyway. Platform asymmetry is honored: systemd gets a non-disruptive `daemon-reload` at write time; on macOS the restart is switched to `bootout`+`bootstrap` because `launchctl kickstart -k` restarts the LOADED job definition and **never re-reads the plist**. On the already-up-to-date paths the sync still self-heals but forces no bounce — on macOS it states that the healed plist takes effect at the next full reload, honestly, instead of restarting a healthy daemon over a unit-file change.
  4. **Rollback stays unit-untouched** (emergency path, minimal moving parts; units aren't versioned). Safe because sync never alters program argv — a test pins that a healed unit still invokes exactly the path where rollback restores code (bundle `.previous` in-place swap / source `previousRef` checkout; both path-stable).
  5. **Out of scope, recorded:** the REST upgrade path (in-band supervisor operations from inside the daemon remain forbidden, ADR-077); the `.autonomos-bin` wrapper script (still only re-rendered by an installer re-run — the sync keeps the unit pointing at it, unchanged); rolling back a healed unit (template evolution is forward-only).
- **Alternatives considered:** re-run `install-service --force` post-upgrade (rejected: hazards (a)+(b) above); record install flags in `install.json` and render from the marker (rejected: existing installs predate any such field, while the installed unit itself is present and authoritative on every supervised install — parse the artifact, not a second bookkeeping copy that can go stale); drift-warn without applying (rejected by Terry's ruling — the deployed shape should converge, not nag).
- **Source:** Terry's ruling via TeamLead (autonomOS channel, 2026-08-10), ReleaseRollout agent session; hazards verified against `install-service.ts` / `install.sh` / `service-control.ts` before the design was proposed.

## ADR-081: Test-only service label — supervisor identity is the isolation boundary, not files

- **Date:** 2026-08-10 — **Decided by:** Terry (standing order + patch assignment after the third production-daemon kill). Provisional number — renumber to next-free at merge per the collision convention.
- **Context: three production-daemon kills in two days, each taking down the entire agent fleet including the agent that caused it.** (1) 2026-08-08: pre-#320 `test-install.sh` ran `stop` with the real `$HOME`; `findInstalledService()` found the real plist; `launchctl bootout gui/<uid>/com.autonomos.daemon`. Fixed by the script-wide HOME redirect. (2)+(3) 2026-08-09, twice: with the redirect HOLDING, `uninstall-service` ran `launchctl unload $TEST_PREFIX/…/com.autonomos.daemon.plist` — **launchctl reads only the Label from the file, then unloads whatever loaded job carries that label. The per-user launchd namespace is global; label collision is path- and HOME-independent, so file isolation cannot fix this class.** The in-script guard (`assert_real_daemon_untouched`, with auto-restore) never fired: killing the daemon kills the agent's own PTY, which kills the script before any after-the-fact assert runs — **the guard shares fate with the victim, so in-process detection-after-the-verb is dead code at exactly the moment it matters.**
- **Decision.**
  1. **`AUTONOMOS_SERVICE_LABEL` env override** (default `com.autonomos.daemon`) is the single source of service identity: the rendered plist `Label`, the plist filename, the systemd unit name (`autonomos.service` in production; `<label>.service` under an override, so existing installs keep their historical name), and **every** launchctl/systemctl target in `service-control` / `install-service` / `uninstall-service`. An env var rather than a flag so no verb can be forgotten. The test harness exports `com.autonomos.daemon.test` at its isolation boundary; every unit it writes and every verb it triggers addresses a job that does not exist in production.
  2. **The invariant is enforced, not followed.** A unit test fails if a unit rendered under the override carries the production identity (exact comparison — the test label contains the production label as a prefix, so substring greps prove nothing), and `test-install.sh` runs `assert_only_test_label` **before** every supervisor-reaching verb (stop, uninstall-service, upgrade, rollback), aborting before the call if any harness-written unit resolves to the production identity. Assert-before-the-verb is the only ordering fate-sharing permits.
  3. **The unit-sync heal (ADR-080) preserves the recovered label** like every other install-time parameter — pinned by a test that heals a test-labeled unit with the override ABSENT and asserts the label survives. Without this, a heal would re-address a test unit to production and resurrect the incident.
  4. **The only permitted production-label reference in the harness is `assert_real_daemon_untouched`** — a read-only `launchctl print` / `systemctl is-active` probe of the real daemon (detection + best-effort restore), never a mutating verb. It remains as a backstop with the documented caveat that it cannot fire on the fate-sharing kill path.
  5. **Orphan reaping:** any pm2 CLI invocation under the redirected HOME auto-spawns a God Daemon homed at `$TEST_PREFIX/home/.pm2` that outlives the script (observed twice; killed manually). `cleanup()` now reaps via `PM2_HOME=… pm2 kill` plus a pkill fallback matching the unique PM2_HOME path (never a broad pattern), and `HUP/INT/TERM` are trapped into a normal exit so the EXIT trap still runs when the script dies mid-run.
  6. **Standing operational order (Terry, permanent):** `scripts/test-install.sh` and all `autonomos` service/lifecycle verbs (`stop`/`restart`/`install-service`/`uninstall-service`/`upgrade`/`rollback`) are **never run on the operator's machine by agents — CI is the only verifier** — same weight as the never-bind-:3100 rule. This PR itself is verified by unit tests + CI only.
- **Alternatives considered:** stronger after-the-fact restore (rejected: fate-sharing makes it unreachable in the failure mode that matters); pid-guarding inside the CLI verbs (rejected: the CLI cannot know which label is "real" — identity, not runtime state, is the boundary); running the harness in a VM/container on macOS (rejected for now: heavyweight, and CI already provides the isolated environment).
- **Source:** Terry's stop order + patch assignment (direct session message, 2026-08-09 night), incident forensics in that message; ReleaseRollout agent session. Relates: ADR-077/079/080, the #320 hermeticity fix this supersedes as "the" guard.
## ADR-082: Dashboard API client layer + push-over-poll migration

- **Date:** 2026-08-09
- **Who:** APIConsolidation agent (mandate: Terry's approved consolidation plan, PR A)
- **Context:** The consolidation audit found the dashboard making every REST call through ad-hoc raw `fetch` (45+ sites, three hand-rolled error-shape conventions) and running ~12 independent `setInterval` timers — none visibility-aware — costing ~940KB/min per tab even backgrounded (agents 55KB×5s, projects 86KB×30s, statuses 3s, tree 5s×2 twins). Meanwhile `/ws/agents` had streamed agent deltas into an empty client set since the channel was built: the server was already event-shaped, and the dashboard never subscribed. Hard product constraint from Terry: the refactor must not degrade responsiveness — foreground behavior stays byte-identical.
- **Decision:**
  1. **Client core** (`api/core.ts`): one `request<T>()` with `ApiError` (status, envelope `code`/`retryable`, `unreachable` getter). In-flight GETs dedup by URL; `fresh` opts out. `signal` is forwarded to fetch on non-deduped requests (fresh + mutations) and DETACHES the caller on deduped GETs — one subscriber's abort can't kill a shared socket.
  2. **Family modules** (`api/{agents,status,schedules,config,misc}.ts`) — typed wrappers per resource; wire shapes live once in `@autonomos/core` (`types/api.ts`), consumed by server routes and client alike.
  3. **Poll manager** (`api/poll.ts`): ref-counted module-level polls behind `useSyncExternalStore` — shared timers, change-only commits with reference stability, errors kept beside stale data. Visibility-gated: hidden tabs pause pure-display polls and THROTTLE notification-bearing ones (`hiddenIntervalMs`, status 3s→15s) because desktop notifications matter most while away; returning fires an immediate catch-up refresh. Foreground cadences are the pre-migration values byte-for-byte.
  4. **Push migration:** `agent.status` joined the `AgentDelta` union (emitted at the routes/hooks.ts chokepoint on every status/unread change; repeat states are not re-emitted) and the `/ws/agents` reconcile now carries a `statuses` map, so a (re)connect needs no follow-up poll. The dashboard's `agentsSocket` client (jittered backoff, visibility reconnect, reconcile-first) feeds `pushBridge`, which suspends the agents/tree/status polls while live and translates frames through the SAME `applyAgentsSnapshot`/`applyStatusSnapshot` paths plus `poll.inject`, so components are source-agnostic. Socket loss resumes polls with an immediate refresh: degrade to polling, never below it. Steady-state per-tab traffic drops from ~940KB/min to event-driven (~5-10KB/min typical fleets).
  5. **Store slimming:** the 11 dead schedule/template/preset store actions (superseded by panels reading polls + api modules) were removed with their store-only test; `templates`/`presets` caches remain for CreateAgentPanel.
- **Rationale:** the server already published deltas — polling was pure waste; suspend+inject lets the socket own cadence without components knowing the source, which is what makes the UX-parity constraint provable (same apply paths, same foreground numbers). Dedup-by-default with `fresh` escape preserves liveness probes (ConnectionStatusBarItem needs real per-tick requests + true cancel).
- **Alternatives considered:** SSE (second transport when a WS exists); per-component sockets (N connections, no shared reconcile); TanStack Query (dependency + cache semantics don't model a push channel handing back to polls); leaving polls as-is with only visibility gating (still 940KB/min foreground).
- **Source:** consolidation PR A (this branch), audit in the APIConsolidation session; UX constraint from Terry's session directive.

## ADR-083: Server unification — typed errors, one Zod source, store-level secrets guard

- **Date:** 2026-08-10
- **Who:** APIConsolidation agent (consolidation PR B, under Terry's approved staged plan)
- **Context:** ADR-078 defined the error envelope and "one validation source" conventions but only the agents surface partially followed them. Every other route hand-rolled `c.req.json().catch(...)` + typeof ladders (64 ad-hoc `c.json({error},4xx)` sites), the HTTP MCP server declared the same request fields a second time as inline zod shapes in mcp.ts, and mcp/tools.ts carried a third hand-written JSON-Schema copy for the channel transport. Writing the drift test for this PR immediately found 58 live description drifts between the two MCP transports — the decay mode was real, not hypothetical. ADR-067's "agents cannot set secret values" was enforced only by each surface's schema remembering to omit the field.
- **Decision:**
  1. **Typed errors + central envelope** (`httpError.ts`): `HttpError(status, {code, retryable, details})` + `installErrorHandling(app, scope)` installed on BOTH listeners (public TCP + internal socket) emitting the ADR-078 envelope, with `notFound` 404s. Router-level onError (agents.ts) keeps its richer handling and gains an HttpError branch — Hono runs the nearest handler, and without that branch a thrown 400 inside that router would surface as a generic 500 (mutation-verified). Routes with in-flight state to flush still catch locally, per the typed-errors convention.
  2. **One Zod source** (`validation.ts`): MCP raw shapes (extracted from mcp.ts verbatim — field sets and all describe() texts verified identical before the description reconciliation) + REST composites, consumed by nine routes via `parseBody` (400 `VALIDATION` with `details.issues`, `BAD_JSON` for unparseable bodies; failing field names folded into the human-readable `error`). Deliberately loose fields stay `z.unknown()` where a documented fallback owns wrong-type handling: spawn id fields (spawnAgent's boundary guard), REST `permissionMode` (ADR-061 legacy-spelling normalization), template `permissionMode`/`capabilities` (report-what-was-ignored). The channel server needs no change — it calls the public REST API, so route validation covers it.
  3. **Channel copy kept honest by test, not import** (`tools-validation-drift.test.ts`): mcp/tools.ts must stay hand-written (bundled into the channel server; bare package imports don't resolve there — see the module's header). `z.toJSONSchema` derives the schema from each Zod shape and asserts property sets, types, enums, required lists, and descriptions match the JSON literals — same pattern as the permission-enum test, now covering all 13 tools with request shapes. The channel texts (richer, fleet-facing) became canonical for descriptions.
  4. **Secrets guard at the store** (`envPresets.ts`): `createEnvPreset`/`updateEnvPreset` STRIP secret values unless the caller passes `writeSecrets` — only the dashboard REST route opts in. ADR-067's asymmetry is enforced structurally; a future surface is safe by construction.
- **Behavior deltas (all strict tightenings):** body-shape failures return the envelope instead of ad-hoc strings; wrong-typed known fields 400 instead of being silently dropped mid-request (previously e.g. a non-string `manager` on the manager route SILENTLY CLEARED the agent's manager; a non-number `version` silently skipped the concurrency check; a bogus `provider` on spawn 500ed); `maxConcurrentRuns` requires an integer. Domain errors (404/409/422/503, cron/target messages) untouched.
- **Alternatives considered:** generating tools.ts from the Zod source at build time (rejected: adds a build step whose failure mode is a stale generated file — the test catches the same drift with less machinery); putting schemas in @autonomos/core (rejected: nothing outside the server consumes them, and core is exactly what the channel bundle cannot import); zod schemas inside mcp/tools.ts (rejected: bundling constraint).
- **Source:** consolidation PR B (this branch); implementation partly by a delegated work agent, verified and extended in the APIConsolidation session.

## ADR-084: Route renames behind one-release compat aliases

- **Date:** 2026-08-10
- **Who:** APIConsolidation agent (consolidation PR C, closing the ADR-078 §paths items)
- **Context:** Three surfaces carried names describing their implementation or history rather than what they serve: `/auth` was the single endpoint outside `/api`; `/api/scheduler/{status,settings}` split scheduler control away from `/api/schedules` for no client-visible reason; and the hook-relay READ surface lived at `/api/hooks` — a name about how the data is produced (hook ingestion) rather than what a client gets (agent activity statuses, notifications).
- **Decision:**
  1. **Renames:** `POST /auth` → `POST /api/auth` (with an explicit `requireAuth` exemption — a browser cannot present the cookie it is asking for); `/api/scheduler/{status,settings}` → `/api/schedules/{status,settings}`; hook READS → `GET /api/agent-status` (bulk status map) and `/api/notifications` (feed + `POST /:sessionId/read`). Hook INGEST (`/api/hooks/:sessionId` on the internal socket) is untouched — the relay curls baked into running agents' spawn settings must keep working.
  2. **One-release aliases:** the old paths stay mounted behind `deprecatedAlias` middleware — same handler FUNCTIONS as the new mounts (the alias cannot drift) — logging one pointer per (method, old mount). Aliases and the middleware are deleted next release.
  3. **Reserved schedule names:** `status`/`settings` are rejected as schedule names at the shared `validateScheduleInput` chokepoint (both REST and MCP create). Mount ORDER is load-bearing and test-pinned: Hono resolves same-base mounts in registration order (verified — NOT static-over-param), so `schedulerRouter` must register before the `:name` router.
  4. **First-party callers moved:** dashboard api modules, App.tsx login, server tests, and the hooks-plane integration probes all use the new paths; the alias behavior (identical payloads, warn-once, reserved names) is pinned by `route-rename-aliases.test.ts`, which mirrors run.ts's mounts and dies with the aliases.
- **Rationale:** names should say what a client receives; the alias window keeps stale dashboards and external scripts working for exactly one release with a log pointer instead of a silent break or an eternal alias.
- **Alternatives considered:** permanent aliases (rejected: two names forever is the drift the consolidation exists to end); renaming the ingest path too (rejected: running agents carry the old ingest URL in their spawn-time hook settings — breaking it strands live fleets); HTTP 308 redirects instead of aliased handlers (rejected: fetch follows them silently, so stragglers would never surface in logs, and non-GET redirect semantics vary by client).
- **Source:** consolidation PR C (this branch), APIConsolidation session.

## ADR-085: Codex MCP tool approval — mode-aware pre-approval + read-only tool annotations

- **Date:** 2026-08-13
- **Who:** Provider agent (T1 fix), under TeamLead@autonomOS relaying Terry's decision (approved "B + C together", priority 1).
- **Context:** Every new Codex session autonomOS spawned prompted the user to approve the autonomOS MCP server, seconds into the session (BASE_CONTEXT nudges the agent toward `list_agents`). Root cause (verified in code + empirically): Codex's `mcp_servers.<name>.default_tools_approval_mode` defaults to `auto`, whose heuristic prompts for any tool that does not declare read-only / non-destructive annotations. autonomOS declared ZERO tool annotations AND set no approval mode, so all 19 channel-server tools prompted — keyed per `(server, tool)`, and the "Allow" Terry picked was session-scoped so it never persisted. Claude Code, given the SAME un-annotated tools, defaults `readOnlyHint→false` + `passthrough` (no prompt) and writes any override to disk — so the identical `permissionMode` produced a *supervised* Codex agent and an *unsupervised* Claude agent, purely from an unstated annotation default. Enum confirmed empirically: `codex -c …default_tools_approval_mode="zzz"` → `expected one of auto, prompt, writes, approve`.
- **Decision:**
  1. **Mode-aware daemon pre-approval (B):** `codexMcpApprovalMode(permissionMode)` maps `bypass`/`auto` → `"approve"` (never prompt) and `ask`/`plan` → `"writes"` (prompt for MUTATING tools, auto-approve `readOnlyHint` tools). Emitted as `-c mcp_servers.autonomos.default_tools_approval_mode=…` inside `daemonConfigArgs`'s `injectChannelServer` block — on the DAEMON, which hosts the MCP client and makes the approval decision (the `--remote` TUI never injects `mcp_servers`). Rides the same `injectChannelServer` gate as the rest of the MCP config, and mirrors `codexApprovalPolicy` (plan clamps to ask-equivalent).
  2. **Read-only tool annotations (C):** `ToolDef` gains an optional `annotations` field; the 6 read-only tools (`list_agents`, `get_org_chart`, `list_templates`, `list_schedules`, `get_schedule`, `list_env_presets`) declare `readOnlyHint: true`. The channel server serves `ALL_TOOLS` verbatim, so this reaches every spawned agent; the HTTP `mcp.ts` forwards each `ToolDef.annotations` through `server.tool()` (single source, no second copy). Under `writes` this auto-approves the reads while mutations still prompt a supervised agent, and it also feeds Claude Code's parallel-execution eligibility.
- **Rationale:** mode-aware (not a blanket `"approve"`) preserves the ask/plan supervision distinction — an `ask` Codex agent is still prompted before `kill_agent`/`delete_*` but not before `list_agents` — while ending the recurring prompt for autonomous agents. Annotations are the correct long-term fix (they describe the tools truthfully for every MCP consumer); the approval mode is what actually suppresses the prompt today. Together: reads never prompt, mutations prompt only supervised agents, autonomous agents never prompt.
- **Alternatives considered:** blanket `default_tools_approval_mode="approve"` for all modes (rejected: auto-approves destructive tools even for a supervised `ask` agent); annotations-only (rejected: mutating tools still prompt under `auto`, and with no mode set it wouldn't fully fix it); a one-time `~/.codex/config.toml` entry the user adds (rejected: fixes only the operator's box, not anyone else running autonomOS, and mutating the user's config.toml is an ownership problem the `-c` route sidesteps); autonomOS writing its own `config.toml` at spawn (rejected: same ownership problem).
- **Verification:** `codex-daemon.test.ts` asserts the mode → approval-mode mapping across all `PERMISSION_MODES` and that it rides the `injectChannelServer` gate; `tool-annotations.test.ts` is a bidirectional drift guard (read-only tools MUST carry `readOnlyHint`; mutating tools must NOT). Both mutation-verified. A live isolated spike (mock model provider, isolated `CODEX_HOME`, ephemeral loopback ports, `~/.codex` untouched, :3100 never contacted) CONFIRMED empirically that the **daemon** raises the MCP approval — `mcpServer/elicitation/request` with `_meta.codex_approval_kind = "mcp_tool_call"`, no `--remote` TUI present — and the daemon's `default_tools_approval_mode` fully governed the outcome across an 8-cell matrix: an un-annotated tool prompts under the `auto` default, and is silent under `approve` or under `writes` when it declares `readOnlyHint`. Nuance: `approval_policy = "never"` (our `bypass`) *already* suppresses MCP prompts on its own, so mapping `bypass → "approve"` is redundant-but-harmless; `ask`/`auto`/`plan` are the modes that prompt today.
- **Source:** T1 investigation (this session) + Terry's decision relayed via TeamLead@autonomOS, 2026-08-13. Renumbered 084 → 085 at merge (collision with the route-renames ADR-084) per the collision convention; the ADR number is kept out of all runtime strings so the renumber needed no code change. Relates: ADR-055 (channel server on the internal socket), ADR-061 (permission modes), ADR-045.

## ADR-086: Trailing-edge frame coalescing (atomic repaints) + jump-to-latest pill

- **Date:** 2026-08-21 — **Decided by:** Terry (reported two release-gating bugs: gemini-cli's bottom region "flashes at a high rate, physically eye-hurting", and Codex panes "occasionally jump to the top of the scrollback"; approved both fixes after diagnosis).
- **Context — the flicker.** #260 made the PTY→WS coalescer flush LEADING-edge: the first chunk after ≥window idle went out immediately (zero echo latency), only intra-burst chunks batched. Raw PTY capture of a live gemini-cli shows why that tears: its Ink TUI emits NO synchronized-output brackets (DECSET 2026 — codex/ratatui emits them ~338/30s; modern Claude Code Ink also brackets, which is the "no-flashing mode" Terry remembered) and repaints its bottom region ~17×/s by cursor-up+erase-line, each repaint spanning several ~1KB PTY reads with >8ms idle before it. So the repaint's FIRST chunk — the erase half — always flushed alone, and the redraw followed a window later: every repaint painted torn. Measured live: 33.7 frames/s with 265/505 inter-frame gaps <12ms (the split-pair fingerprint).
- **Decision.** (1) The coalescer is now TRAILING-edge by default with a 5ms window: every chunk waits ≤5ms for siblings, so a multi-chunk repaint lands in ONE WS frame, which xterm parses before its next paint — repaints are atomic without the TUI's cooperation. Measured on the same live gemini: 14.2 frames/s (its natural cadence), split pairs 265 → 6 (−98%), blank-ending frames 9 → 1. Leading-edge survives as `AUTONOMOS_WS_COALESCE_LEADING=1` (ablation only) and as a `leadingEdge` option for tests. The regression guards are the trailing-edge unit tests plus a DEFAULT_COALESCE pin (flag defaults asserted with the env unset); the L2 burst spec additionally reports a `tightPairs` metric (frames <12ms apart) as the live-load diagnostic. Cost accepted: ≤5ms added echo latency after idle — below one display frame, and the price bought nothing when it shipped torn paints. (2) Codex "jump-to-top": NOT a pipeline defect — reconnect/replay, keep-alive reattach, resize/reflow, alt-screen, and live-burst paths all hold the bottom (probed against xterm's real buffer state on a deep-scrollback Codex-shaped session). Codex captures no mouse, so trackpad flicks and Shift+PageUp scroll xterm's own scrollback and switch follow-off silently — Terry confirmed the trigger is touch-adjacent with no reconnect. Mitigation: a per-pane "↓ Jump to latest" pill whenever the viewport parks off-bottom (rendered on unfocused panes too, so a pane wandered-into-parked advertises itself before click-in), one click back to the live tail; typing already re-follows (xterm `scrollOnUserInput` default).
- **Alternatives considered and rejected:** *Synthesizing DECSET 2026 brackets around frames server-side* — doesn't help: the torn frame is torn because the erase and redraw are in DIFFERENT frames; atomicity within a frame was never the problem. *Heuristic leading-edge (flush only chunks ending in printable text)* — fragile against PTY read boundaries that cut mid-sequence. *Auto-yank the viewport on new output* — deliberately rejected; parking to read history is legitimate, the pill makes recovery one click without stealing the position.
- **Test evidence.** Coalescer suites rewritten for trailing default incl. the repaint-ships-whole case (erase+redraw one frame) and leading-edge under the flag; the exit-flush invariant restructured (both chunks pending → flushed by onExit); follow-indicator dom test (park → notify, jumpToLatest → recover) — 15+15 green. Live A/B and pill click-through verified on the isolated rig with a real gemini-cli agent and a Codex-shaped deep-scrollback session.
- **Source:** autonomOS CC session (TerminalRender agent), diagnosis approved by Terry via TeamLead 2026-08-21.

## ADR-087: No fake-resize repaint nudge; anchor parked viewports across app scrollback wipes

- **Date:** 2026-08-22 — **Decided by:** Terry via TeamLead ("get it fixed"; reopened the ADR-086 codex jump-to-top as deterministic-on-click, re-gating v0.6.0).
- **Context — the real mechanism (live-loop repro, replacing ADR-086's exoneration).** ADR-086's probes all ran PINNED at the bottom — the user's ambient state on a long session is PARKED, and the reopened report's trigger was precise: click into the dashboard from another app. That window-focus fired `nudgeResize`, a deliberate cols−1→cols fake PTY resize pair whose only purpose was forcing a repaint after unfocus (a pre-keep-alive relic). Codex's ratatui answers EVERY resize with a full rebuild — captured verbatim: `\e[r \e[0m \e[H \e[2J \e[3J` + ~38 reverse-index/scroll-region ops + a full transcript re-emit (21KB per refocus on a 91-line session). **`\e[3J` erases xterm's scrollback**, clamping the viewport to 0; the rebuild regrows baseY; the follow logic correctly refuses to yank a parked viewport → stranded at the absolute top. Measured: parked {vY:49,bY:91} → one refocus → {vY:0,bY:91}. Deterministic; compounds (each strand re-parks at top). Pinned sessions survive — which is exactly why the first exoneration missed it.
- **Decision.** (A) The fake-resize nudge is REMOVED from the window-focus handler (the every-click trigger). Per review, it is RETAINED on ws.onopen — the reconnect path is where it originated (#16, "fixes cursor-below-rendering after buffer replay") and it fires while follow-state is freshly pinned, so a rebuild there cannot strand a parked viewport (and (B) is the net). Real size changes still propagate via the plausibility-guarded `applyFit`; the nudge's repaint purpose has been covered since ADR-072 by WebGL-recreate-on-attach and the onContextLoss rebuild, and a reconnect's reset+full-replay IS its own repaint. Verified live: parked + refocus now sends **0 bytes** to codex (nothing to rebuild), and reconnect-while-attached renders fully without the nudge. (B) An xterm CSI parser hook observes **ED3** (`\e[3J`, never consumed): if the app wipes the scrollback while the viewport is parked, a flag re-pins to the live tail after that frame finishes parsing — the content the user was reading no longer exists, so following the tail is the only sensible landing. This covers REAL resizes (window/pane geometry), which still legitimately trigger codex's rebuild: verified live, parked + real resize now lands at the tail (pill dismisses) instead of the top.
- **Alternatives considered and rejected:** *Keep the nudge but debounce/single-resize* — still one SIGWINCH per refocus, still a full 3J rebuild per click; the nudge serves no remaining purpose worth any rebuild. *Detect the wipe by baseY-collapse heuristics in onScroll* — the wipe and rebuild arrive in ONE trailing-edge frame, so post-frame state shows baseY regrown; only the parser-level ED3 observation sees the wipe reliably. *Ask users to click the ADR-086 pill* — dozens of clicks a day is not a fix for a trigger we own.
- **Test evidence.** Dom tests pin: the captured wipe sequence re-pins a parked viewport to the tail and dismisses the pill; ED3 while pinned is a no-op; window refocus never emits the cols−1 perturbation (≤1 true-size resize allowed). 20/20 liveTerminals dom tests green; live-verified on a REAL codex agent (0 bytes on refocus; tail-landing on real resize; reconnect renders).
- **Source:** autonomOS CC session (TerminalRender agent), reproduced + fixed same session, 2026-08-22.

## ADR-088: Sidebar recency indication — timestamp-only fade (B2)

- **Date:** 2026-08-22 — **Decided by:** Terry, via TeamLead, after reviewing a two-round option mockup ("I really like the B2, don't like others"). Scoped into the v0.6.0 gate as the last item.
- **Context.** Every sidebar agent row's last-activity timestamp ("41m"/"11d", top-right) rendered as a flat neutral `statusFg` at full opacity — a 2-minute session and a 34-day session read at identical weight, so a fleet of mostly-stale sessions gave no glance-level signal of which agents are live. Goal: make wildly-stale sessions **practically ignorable at a glance** without adding row noise. Round 1 explored the timestamp color/opacity lever (alarm ramp vs de-emphasis fades); round 2 widened to stronger channels (date grouping, row compression, edge/icon/typography). Terry picked the round-1 **B2 — timestamp-only fade** and explicitly rejected the alternatives (no grouping/compression/edge/ring/weight, no alarm colors, no icon-preserve variant).
- **Decision.** Only the timestamp span changes; the row, name, status icon, and repo·branch line are untouched. **fresh** (<1h) → the theme's **foreground / text color** at full opacity (void `#d4d4d4`); **recent** (1–24h) → neutral `statusFg`, full opacity; **stale**/**ancient** fade by opacity on a **theme-aware ramp**: dark themes `72%` / `52%` ("Balanced wide"), light themes `86%` / `74%`. The lower three thresholds coincide with `formatAge`'s own unit boundaries (m→h→d); the 7d stale→ancient step is a recency threshold, not a unit change. Opacity (not a pre-blended color) carries the fade so it recedes toward whatever is behind the text — page background or an active-row highlight. **The ramp must be theme-aware** because opacity composites toward the background: on a dark theme "fainter" fades toward black (contrast preserved), but on a light theme it fades toward white and — since `statusFg` is already low-contrast on a near-white page — collapses to ~1.6:1 (illegible) at the dark ramp's depths. So the ramp is chosen by `isLightBg(page.bg)` (Rec. 601 luma > 0.5), which classifies any theme by its own background rather than a hardcoded name. Buckets are computed inline from the same `lastActive` the text renders from, on the sidebar's existing ~5s render pass — **no new timer**. Logic lives in a pure, tested `recency.ts` (`recencyBucket` + `recencyTimestampStyle` + `isLightBg`) with zero embedded palette.
- **Two design points that survived iteration:** (1) **Fresh = the theme's `fg` token**, not a bespoke color. Terry iterated the accent through a cool tint, then mint/neutral/cyan, and landed on the neutral gray `#d4d4d4` — which *is* void's foreground. Using `fg` directly makes fresh legible on every theme by construction (a theme's text color is always legible on its own background — no per-theme tuning, no light-theme wash-out), and it anchors the bright end of the range: with fresh at ~212 brightness instead of gray-at-100% (~156), the four buckets have room to read as distinct steps (fresh > recent > stale > ancient), which they did **not** at the first shallow ramp (stale 90% ≈ ancient 80% was indistinguishable at 10px). (2) The fade **guards the timestamp, not the derived age**, on the same terms as `formatAge` (`!finite || ≤ 0 → "unknown"`): `now - 0` is a huge positive age that would otherwise bucket "ancient" and fade a missing-timestamp "unknown" label to near-invisibility — the exact failure the feature exists to avoid. A degenerate timestamp yields full opacity, agreeing with `formatAge`.
- **Alternatives considered and rejected:** *A — classic alarm ramp (green→amber→red)* — inverted salience (loudest colors on the rows you can ignore), red/green colorblind risk, and amber collides with the gold preset pill. *Structural grouping / row compression / edge / icon-ring / typography-weight* (round 2) — rejected by Terry in favor of B2's simplicity (grouping/compression were also M–L cost, a possible fast-follow). *A per-theme cool-tint token (`page.recencyFresh`)* — built, then dropped once the accent resolved to `fg`: a bespoke token added surface for a value the existing `fg` already provides, and its dark-theme value washed out on the light theme. *Shallow "Whisper" fade (stale 90% / ancient 80%)* — legible but stale≈ancient, because four buckets can't separate in a ~20-point opacity band. *Merge to three levels* and *cool-the-ancient slate* — considered as fixes; the wider opacity spread won once `fg` widened the range. *A settings option for the color* — deferred: subtle always-on cue (YAGNI) and a free picker would let users choose a theme-illegible value; the per-theme structure makes a curated dropdown a cheap future add if wanted.
- **Test evidence.** `recency.test.ts` pins exact bucket boundaries, both ramps (dark 72%/52%, light 86%/74%), `isLightBg` classification (void/midnight → dark, daylight → light, unparseable → dark), the theme-`fg` fresh color, and degenerate timestamps (0/negative/future/NaN → full opacity in both ramps); `Sidebar.recency.dom.test.tsx` pins the wiring end-to-end (void ancient → 0.52, daylight ancient → 0.74 proving `page.bg` drives ramp selection, fresh → `fg` `rgb(212,212,212)` at full opacity, name NOT faded, missing-timestamp "unknown" → full opacity). The guard fix, the ramp, and the light/dark switch are each mutation-verified RED first. Rendering visually verified across void/midnight/daylight and on a live proxied fleet.
- **Source:** autonomOS CC session (Shortcuts agent), Phase 2 implementation, 2026-08-22.

## ADR-089: Auth continuity across install-shape changes — migrate the operator-identity keys, drop other overrides loudly

- **Date:** 2026-08-26 — **Decided by:** Terry ("upgrade should NOT break older users especially with their existing tokens" — a standing invariant, not a bug fix), mechanics by the release engineer. Provisional number — renumber to next-free at merge per the collision convention.
- **Context.** The v0.6.0 forge migration (rsync tree → managed clone, ADR-079) silently changed the daemon's accepted token: operator config lived in a `.env` inside the OLD install tree (loaded via the service wrapper's `tsx --env-file=<repo>/.env`), the fresh clone had none, so the daemon fell back to `$configDir/token` and every existing browser session 401'd with no pointer to the new credential. Every self-hosted install migrating from the pre-ADR-077 README shape carries exactly this `.env`. The defect was disclosed at execution but classified as a migration footnote; Terry reclassified it: **an upgrade or migration must never change what token the daemon accepts without migrating it or saying so.**
- **Decision.**
  1. **`install-source.sh` migrates the OPERATOR-IDENTITY keys** — `AUTONOMOS_TOKEN` (what login accepts), `AUTONOMOS_HOST` (dropping a loopback restriction would silently WIDEN the bind to all interfaces — review catch), and `AUTONOMOS_CONFIG_DIR` (dropping it boots an empty fleet that looks like a migration that ate the agents) — from the `.env` of the tree it was launched from into the new clone (verbatim lines, `0600`, provenance header), BEFORE the first boot. Continuity of auth, exposure, and state location is the default a user expects. Duplicate keys resolve to the LAST assignment — verified empirically against `node --env-file` and `tsx --env-file` (a token rotated by appending migrates as the live value, not the dead first one — review catch). It never overwrites an existing clone `.env` and no-ops on adopt-in-place.
  2. **Every other `.env` key is dropped LOUDLY**: named on stderr (values withheld — they may be secrets), with the old file's path as the one-copy restore hint. Carrying unknown overrides silently would be the inverse bug — e.g. a stale `AUTONOMOS_WS_COALESCE=0` pinning old transport behavior through every future upgrade. A `.env` with NO token still carries the other identity keys (the bind hazard is token-independent) and gets an explicit "your login token is about to change" warning naming the file the new token lives in.
  3. **The invariant is a contract test**, not just behavior: `scripts/install-source-env.test.ts` starts from a fixture whose token authenticated before, runs the real bash, and asserts the SAME literal token is what the new install supplies — its failure message says "UPGRADE BROKE EXISTING AUTH". A second empirical test proves an untracked `.env` survives the exact git verbs `sourceUpgrade.ts` runs (tag checkout + targeted revert) on a real repository.
  4. **Process control (owned by TeamLead, encoded in docs/RELEASE.md):** every migration/upgrade/install PR carries a "USER-VISIBLE BREAKAGE" section — itemized or empty-with-proof — and anything auth-touching is a hard human gate before merge.
- **Audit of the other auth-continuity surfaces (evidence in the fix PR):** bundle `install.sh` re-run and `performUpgrade` touch only the bundle dir (token lives in `$configDir`, never in the bundle); `sourceUpgrade.ts` runs no `git clean` and only tag checkouts + tracked-path reverts (empirically proven above); the supervisor unit and wrapper bake no token (unit `Environment=` carries HOME/PATH only, ADR-080 preserves them); `uninstall-service` removes only the unit file; `make deploy` rsyncs with `--exclude .env` by design.
- **Open question (deliberately NOT built here):** operator config living in the install tree dies on every shape change by construction — relocating it to `$configDir` (surviving ANY reinstall) is the structural fix, but it changes the config contract for every install shape at once. Proposed for Terry as its own decision, not smuggled into a patch release.
- **Source:** Terry via TeamLead relay (2026-08-26), forge incident forensics in the release-engineer session; fix PR (this branch).
