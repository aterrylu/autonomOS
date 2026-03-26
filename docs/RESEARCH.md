# Research & Learnings

Document all research findings here. Link sources. Include your assessment of relevance to autonomOS.

---

## To Investigate

- [x] **dimensionalOS** — Agent-native robotics OS (Apache 2.0). Module graph architecture, MCP-based agent↔robot bridge, OpenClaw plugin. Full analysis: [`docs/research/dimensionalOS/`](research/dimensionalOS/)
- [x] **OpenClaw internals** — Runtime architecture, session model, cron system, memory layer, plugin SDK, gateway RPC surface. Full analysis: [`docs/research/openclaw/`](research/openclaw/)
- [x] **Claude Code hooks & workflows** — Terry's custom setup in `aterrylu-dev/claude`. Understand what conventions/patterns could be integrated.
- [x] **Multi-agent coordination** — Claude Code agent teams, `/loop`, `ralph-loop`, community orchestrators (Overstory, CC Mirror, gstack, Ruflo), fork+query pattern for non-blocking introspection. Full analysis: [`docs/research/multi-agent-coordination/`](research/multi-agent-coordination/)
- [x] **Agent frameworks & SDKs** — LangGraph, Claude Agent SDK, Claude Code, Gemini ADK, AN SDK (21st.dev), n8n. Comparison, integration points, patterns. Full analysis: [`docs/research/agent-frameworks/`](research/agent-frameworks/)
- [x] **Google A2A (Agent2Agent) Protocol** — Inter-agent communication standard (Linux Foundation, Apache 2.0). Agent Cards, task lifecycle, JSON-RPC/SSE/gRPC, discovery, MCP comparison, 150+ org ecosystem. Full analysis: [`docs/research/a2a-protocol/`](research/a2a-protocol/)
- [x] **Claude Code CLI Flags** — Full evaluation of ~40 CLI flags for autonomOS integration. `--session-id` (deterministic IDs), `--permission-mode auto` (safe autonomous mode), `--brief` (SendUserMessage structured messaging), `--agents` (custom personas). Full analysis: [`docs/research/claude-code-flags/`](research/claude-code-flags/)
- [ ] **Robot middleware** — ROS2, micro-ROS, foxglove. How do they handle observability and control?
- [x] **cmux** — Native macOS terminal for multi-agent workflows (Swift/AppKit, libghostty). Notification system, integrated browser, agent automation API, CLI/socket control. Full analysis: [`docs/research/cmux/`](research/cmux/)

---

## Findings

### Google A2A (Agent2Agent) Protocol (2026-03-19)

**What:** Open standard for agent-to-agent communication (Linux Foundation, Apache 2.0). Announced April 2025 by Google, donated to Linux Foundation June 2025. v0.3.0 released July 2025. 150+ org ecosystem including all major hyperscalers. IBM's competing ACP merged into A2A by August 2025.

**Key findings:**
- **Complements MCP, doesn't compete.** MCP = agent ↔ tools (vertical). A2A = agent ↔ agent (horizontal). Both needed in a full multi-agent stack.
- **Agent Card** — JSON discovery document at `/.well-known/agent.json`. Contains: name, description, url, skills[], capabilities (streaming, pushNotifications), defaultInputModes/OutputModes, authentication schemes. Cards can be signed (JWS) in v0.3+.
- **Task lifecycle** — 8 states: `submitted → working → input-required | auth-required → completed | failed | canceled | rejected`. Terminal states cannot be restarted; new task required in same contextId.
- **Transport** — HTTPS + JSON-RPC 2.0 (required). gRPC (optional, v0.3+). REST binding also available. Key methods: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/pushNotificationConfig/set`.
- **Three update modes** — synchronous response, SSE streaming, and webhook push notifications (for long-running/disconnected scenarios). Webhook calls authenticated via JWT + JWKS.
- **contextId** — groups related tasks across a "conversation". analogous to autonomOS project concept.
- **Opaque agents** — clients cannot see agent internals, only Agent Card + task outputs. Intentional design for cross-framework interoperability. Conflicts with autonomOS's deep observability goal.
- **Ecosystem maturity** — LangChain, LlamaIndex, CrewAI, LangGraph, Semantic Kernel all have adapters. Google ADK has native support. Microsoft integrated into Azure AI Foundry and Copilot Studio. SAP integrated into Joule.

**Relevance: HIGH for long-term, MEDIUM for now.** A2A is the right protocol for autonomOS's external-facing task delegation interface (Phase 2+). For Phase 1 (Claude Code-only, internal), continue with PTY/hook/JSONL — it gives deeper observability than A2A's opaque model. Immediate action: align internal task state model with A2A semantics so the Phase 2 transport mapping is trivial.

Full analysis: [`docs/research/a2a-protocol/`](research/a2a-protocol/) — README, architecture, Agent Card schema, MCP comparison, ecosystem, autonomOS integration analysis.

---

### dimensionalOS (2026-03-04, updated with source-level deep dive)

**What:** Open-source robotics framework by Dimensional Inc. (~1200 files, 33 packages). Python SDK for controlling robots via module graph architecture. Local checkout: `~/workspace/dimos/`, `~/workspace/roboclaw/`.

**Key findings (from source analysis):**
- **Module system** (`dimos/core/module.py`): `ModuleBase` → `Module` deployed as Dask Actors. Typed `In[T]`/`Out[T]` streams with state machine (UNBOUND→READY→CONNECTED→FLOWING). RxPY observables for reactive composition with backpressure.
- **Blueprint composition** (`dimos/core/blueprints.py`): `autoconnect()` groups streams by `(remapped_name, type)`, assigns shared transport. Spec-based module ref matching (structural + annotation compliance). Requirement checks pre-deploy.
- **Transport abstraction** (`dimos/core/transport.py`): 8 transport backends (pLCM, LCM, SHM, JPEG variants, ROS, DDS). Swappable per-stream at blueprint level. Auto-selects based on type introspection.
- **@skill → MCP pipeline** (`dimos/agents/annotation.py` → `dimos/protocol/mcp/mcp.py`): `@skill` marks methods as both RPC-callable and agent-visible. `MCPModule` collects all skills via `get_skills()`, starts TCP:9990 JSON-RPC server. ~200 lines total.
- **Agent module** (`dimos/agents/agent.py`): LangGraph state machine. `_skill_to_tool()` converts `SkillInfo` → `StructuredTool`. Subscribes to perception streams, publishes agent reasoning.
- **Complete data flow traced**: OpenClaw → roboclaw TCP → MCPModule JSON-RPC → RpcCall via LCM → UnitreeSkillContainer.relative_move → NavigationInterface → A* planner → Twist on cmd_vel → GO2Connection.move → WebRTC to motors.
- **roboclaw plugin** (`~/workspace/roboclaw/index.ts`): ~180 lines. Synchronous tool discovery at startup (child process TCP → initialize → tools/list). Async execution per call (30s timeout, fresh TCP connection). JSON Schema → TypeBox translation.
- **10+ robot skills exposed**: `relative_move`, `navigate_with_text`, `tag_location`, `observe`, `standup`, `liedown`, `execute_sport_command`, `go_to_absolute`, gripper ops, pick/place.
- **Spatial memory** (`dimos/perception/spatial_perception.py`): CLIP/ResNet embeddings (512-dim) → ChromaDB. Queryable by text, image similarity, or named location. Temporal awareness.
- **Sim/replay**: MuJoCo via subprocess + SHM (no GPU needed). Replay from Git LFS recordings (~2.4 GB). Both use same module code as real hardware.
- **License:** Apache 2.0 (dimos), NO license (roboclaw — patterns usable, code not).

**Relevance: HIGH** — Direct template for robot path AND core abstraction design for both paths. Integration strategy: autonomOS talks to DimOS via MCP for robot path. Module/Blueprint/Spec patterns inform our TypeScript core abstractions.

Full analysis: [`docs/research/dimensionalOS/`](research/dimensionalOS/) — includes architecture, MCP & agents, roboclaw bridge, hardware, autonomOS integration analysis, licensing.

### OpenClaw Internals (2026-03-04)

**What:** Multi-channel AI agent orchestration platform (TypeScript, MIT License). WebSocket gateway routing 22+ messaging channels to AI agents. Handles sessions, memory (vector DB), cron scheduling, tool execution, and plugin extensions. Local checkout at `~/workspace/openclaw/`, version `2026.3.3`.

**Key findings:**
- **Gateway is the integration hub.** 50+ WebSocket RPC methods give us full CRUD over sessions, agents, cron jobs, config, and devices. autonomOS connects as a WebSocket client — no forking needed.
- **Plugin SDK is the extension point.** `OpenClawPluginApi` exposes `registerTool()`, `registerHook()` (25 lifecycle events), `registerGatewayMethod()`, `registerHttpRoute()`, and more. An `autonomos` plugin (~500 lines) can fill every observability gap.
- **Memory uses sqlite-vec + hybrid search.** Per-agent vector DB with embeddings (OpenAI, Mistral, Voyage, Gemini, Ollama) and BM25 keyword search. Matches our needs but search isn't exposed via gateway RPC — needs a plugin to expose.
- **Cron system is complete.** Job model with `at`/`every`/`cron` schedules, isolated agent execution, JSONL run logging, failure alerts. Full CRUD via gateway RPC.
- **Sessions are sender-scoped.** JSON file store with in-memory cache, write lock queue, auto-maintenance. Good for messaging but thin for orchestration — no multi-agent sessions.
- **Mission Control already built a dashboard.** [builderz-labs/mission-control](https://github.com/builderz-labs/mission-control) is a Next.js 16 app with SSE, SQLite, 64 API routes, 26 panels. OpenClaw-locked but patterns (event bus, Claude Code scanner, thin routes) are directly portable.
- **Key gaps:** No aggregate token analytics, no multi-agent orchestration, no task management, no dashboard. These are exactly what autonomOS provides.
- **License:** MIT (Peter Steinberger, 2025). Fully commercial-friendly, no concerns.

**Relevance: CRITICAL** — This is the substrate we build on. Integration strategy: WebSocket client (Phase 1) + OpenClaw plugin (Phase 2) + autonomOS DB for aggregation/features OpenClaw doesn't have.

Full analysis: [`docs/research/openclaw/`](research/openclaw/)

### Agent Frameworks & SDKs (2026-03-04)

**What:** Landscape analysis of 6 agent frameworks/SDKs — LangGraph, Claude Agent SDK, Claude Code, Gemini ADK (Google), AN SDK (21st.dev), and n8n. Focused on understanding integration points, patterns, and how autonomOS relates to each.

**Key findings:**
- **These operate at different stack layers** — autonomOS doesn't compete with any of them, it sits at the control plane layer above them all.
- **LangGraph**: Most mature orchestration framework. Graph-based, model-agnostic, verbose. Rich callback system for observability. Good for complex multi-agent workflows.
- **Claude Agent SDK**: Minimal (~500 LOC), Claude-only. Clean hooks system. Best fit for autonomOS's own internal agents.
- **Claude Code**: Product, not framework. First agent autonomOS should observe. Hooks + MCP are the integration surface.
- **Gemini ADK**: Google's framework. Hierarchical multi-agent, multi-modal (audio/video). Heavier. Relevant for robot path (camera/voice).
- **AN SDK**: Agent-native UI components (React). Novel — makes UIs agent-interactable. Could make autonomOS dashboard agent-controllable.
- **n8n**: Automation platform with 400+ integrations. Best as a glue layer — route agent events to Slack, databases, etc. without building integrations ourselves.
- **Common integration pattern**: All frameworks expose lifecycle hooks/callbacks. autonomOS adapters should follow a consistent hook-based pattern.
- **License note**: n8n uses Sustainable Use License (not true open-source; commercial restrictions above $40k revenue).

**Relevance: HIGH** — Directly informs integration strategy and `packages/core` abstraction design.

Full analysis: [`docs/research/agent-frameworks/`](research/agent-frameworks/)

### Multi-Agent Coordination (2026-03-14)

**What:** Research into how Claude Code coordinates multiple agents (native agent teams, `/loop`, `ralph-loop`), community multi-agent projects (Overstory, CC Mirror, gstack, Ruflo), and the Agent SDK's session management capabilities. Focused on finding the right communication architecture for autonomOS's orchestrator.

**Key findings:**
- **Native agent teams** use a leader/teammate hierarchy with shared task lists and mailbox messaging. Not suitable for autonomOS because teammates are hidden inside the lead's PTY — we lose per-agent visibility.
- **Fork + Query** is the preferred pattern for non-blocking coordinator introspection. Fork an idle session, ask the fork about status/progress, discard. Original agent is never disrupted. Requires session to be idle (cannot fork running sessions).
- **Hook telemetry** (global `PreToolUse`/`PostToolUse` hooks POSTing to our server) gives real-time agent state for the dashboard — tool calls, idle detection, permission prompts.
- **Three-layer architecture decided:** Hooks (always-on telemetry) → Fork+Query (on-demand deep introspection) → PTY stdin (direct intervention). Layers are complementary.
- **Agent SDK V2** supports persistent multi-turn sessions via `unstable_v2_createSession()` + `send()`/`stream()`. Cleaner than node-pty for programmatic control, but node-pty gives us the terminal UI users expect.
- **Community projects** (Overstory, CC Mirror) validate the worktree-isolation and task-dependency-graph patterns. Overstory's SQLite mail system and typed protocol messages are worth studying.
- **JSONL direct read** is a zero-cost bonus — session transcripts are written incrementally and can be parsed at any time, even during active sessions.

**Relevance: CRITICAL** — Directly defines the orchestrator architecture for autonomOS.

Full analysis: [`docs/research/multi-agent-coordination/`](research/multi-agent-coordination/)

### Zo Computer (2026-03-05)

**What:** Personal AI cloud server platform by Zo Inc. (ex-Venmo/Substack/Stripe founders). Each user gets a dedicated containerized Linux server with AI agent capabilities, 50+ built-in tools, integrations (Gmail, Notion, Linear, etc.), and web hosting. Users interact via web UI, desktop app, SMS, or email. Backed by Lightspeed, South Park Commons, Craft Ventures. Closed-source core; skills registry is MIT.

**Key findings:**
- **Different layer than autonomOS.** Zo is infrastructure + runtime (where agents run); autonomOS is the control plane (observing/orchestrating agents). Complementary, not competitive.
- **MCP server** at `api.zo.computer/mcp` exposes 50+ tools via standard MCP protocol. autonomOS could connect as an MCP client to access Zo's cloud compute and integrations without custom code.
- **Skills registry** (60+ skills, MIT) uses `SKILL.md` format — markdown frontmatter + natural language instructions. Clean, portable pattern for defining agent capabilities.
- **Agent scheduling** — built-in cron-like scheduler for background agent execution. Simple time-based only, no workflow DAGs or multi-agent coordination.
- **Claude Code on Zo** — runs Claude Code directly on Zo servers with persistent storage, always-on compute, and access to all Zo integrations.
- **REST API** with 50+ endpoints across 10 domains, SSE streaming, Bearer auth, OpenAPI spec.
- **No real-time agent observability** — polling-based API for agent status. No WebSocket/SSE for live execution monitoring.
- **Closed-source core** — cannot study internals. Only skills registry and utilities are open.
- **UX reference** — clean web UI with chat interface, file browser, terminal, agent management, and integrations dashboard. Good reference for autonomOS dashboard design.

**Relevance: MEDIUM** — Not a reference implementation we can study deeply (closed-source), but a valuable UX reference and potential infrastructure provider. MCP integration is the concrete opportunity; skills registry pattern is worth adopting.

Full analysis: [`docs/research/zo-computer/`](research/zo-computer/)

### cmux (2026-03-23)

**What:** Native macOS terminal app for multi-AI-agent workflows by manaflow-ai (Swift/AppKit, libghostty). 9,774 stars in ~2 months. Built because existing terminals lacked contextual notifications and metadata for parallel agent sessions.

**Key findings:**
- **Notification system is table stakes.** OSC sequence detection + visual rings on panes + notification panel + jump-to-unread shortcut is the design autonomOS should match. The `cmux notify` CLI (wired into hooks) solves the daily pain of not knowing which agent needs attention.
- **Sidebar metadata density.** Each workspace tab shows: git branch, PR status/number, working directory, listening ports, latest notification text. autonomOS session cards should show the same.
- **Primitive vs orchestrator.** cmux explicitly says it is "a primitive, not a solution" — composable building blocks, no prescriptive workflow. This is the opposite of autonomOS's orchestrator-first vision (ADR-012). Not competitive — different bets.
- **Integrated browser with agent automation API.** WKWebView + vercel-labs/agent-browser port. Agents can interact with dev servers directly. autonomOS has no equivalent (markdown preview is close but not agent-scriptable).
- **Native performance advantage.** libghostty (C) vs xterm.js/WebGL. Real difference for heavy terminal workloads.
- **No session persistence for processes.** cmux restores layout/scrollback on relaunch but NOT live process state. autonomOS's PM2 + pinned sessions is a genuine advantage.
- **No orchestration layer.** cmux has no project model, no PM agent, no cross-workspace coordination. autonomOS's entire ADR-012 vision is what cmux explicitly chose not to build.
- **AGPL-3.0 license.** Strong copyleft. Cannot incorporate code directly, but patterns and API design are fine to study.

**Immediate action items:**
1. Ship `POST /api/notify` endpoint + session card badge — closes the most visible gap vs cmux
2. Add git branch to session cards (run `git branch --show-current` from CWD)
3. Prioritize notification system in "Next" milestone (already in ADR-019)

**Relevance: HIGH** — Direct competitor in the multi-agent terminal UX space, but with a fundamentally different product bet. cmux validates the notification + metadata features autonomOS needs to ship. The orchestrator vision (ADR-012) is autonomOS's clear differentiation.

Full analysis: [`docs/research/cmux/`](research/cmux/)
