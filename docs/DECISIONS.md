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
