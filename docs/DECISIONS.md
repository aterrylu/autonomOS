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

