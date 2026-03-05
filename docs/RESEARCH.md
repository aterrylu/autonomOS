# Research & Learnings

Document all research findings here. Link sources. Include your assessment of relevance to autonomOS.

---

## To Investigate

- [x] **dimensionalOS** — Agent-native robotics OS (Apache 2.0). Module graph architecture, MCP-based agent↔robot bridge, OpenClaw plugin. Full analysis: [`docs/research/dimensionalOS/`](research/dimensionalOS/)
- [x] **OpenClaw internals** — Runtime architecture, session model, cron system, memory layer, plugin SDK, gateway RPC surface. Full analysis: [`docs/research/openclaw/`](research/openclaw/)
- [ ] **Claude Code hooks & workflows** — Terry's custom setup in `aterrylu-dev/claude`. Understand what conventions/patterns could be integrated.
- [ ] **Existing agent orchestration platforms** — LangGraph, CrewAI, AutoGen, etc. What do they get right/wrong?
- [ ] **Robot middleware** — ROS2, micro-ROS, foxglove. How do they handle observability and control?

---

## Findings

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
