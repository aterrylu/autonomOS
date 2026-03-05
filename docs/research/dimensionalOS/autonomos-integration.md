# autonomOS ↔ DimOS Integration Analysis

> This is the most important research document — it maps DimOS patterns directly to autonomOS decisions.

## Concept Mapping

| DimOS Concept | autonomOS Equivalent | Notes |
|---------------|---------------------|-------|
| `Module` | Agent / Resource / Service | Base abstraction: typed node with inputs, outputs, lifecycle |
| `In[T]` / `Out[T]` | Event streams / Data feeds | Typed pub/sub — agents subscribe to task queues, publish results |
| `Blueprint` | Agent Configuration / Workflow | Declarative composition: which agents, what tools, how they connect |
| `autoconnect()` | Auto-wiring | Match agents to resources by name+type |
| `Spec` (Protocol) | Plugin Interface | Duck-typed contracts for plugin interop |
| `@skill` → MCP tool | Agent capability → API endpoint | Automatic tool discovery and registration |
| `MCPModule` | MCP bridge / Integration layer | Expose agent capabilities to external systems |
| `GlobalConfig` | Dashboard settings / Agent config | Centralized configuration with env var override |
| `Transport` | Communication backend | Abstract: WebSocket for dev path, LCM for robot path |
| `ModuleCoordinator` | Orchestrator / Scheduler | Deploys, wires, starts, stops modules |
| Spatial Memory (ChromaDB) | Agent Memory | Persistent, queryable, temporal knowledge store |
| `dimos run <blueprint>` | `autonomos deploy <config>` | CLI to launch a configured system |
| Rerun / Foxglove viewer | autonomOS Dashboard | Real-time observability of system state |

## Patterns to Adopt

### 1. Module = Typed Node with I/O

DimOS proves that everything — hardware, perception, agents, visualization — can be a `Module` with typed streams. For autonomOS:

```
# Dev path modules
ClaudeCodeSession: Out[TaskResult], In[TaskRequest]
OpenClawAgent: Out[AgentMessage], In[UserPrompt]
CronScheduler: Out[TriggerEvent]
Dashboard: In[*]  # subscribes to everything for observability

# Robot path modules (future)
DimOSBridge: Out[SensorData], In[MotorCommand]  # wraps DimOS via MCP
```

### 2. Blueprint = Declarative Composition

Instead of imperative setup code, autonomOS should let users declare what they want:

```yaml
# autonomos-config.yaml (hypothetical)
name: my-dev-setup
modules:
  - type: openclaw-agent
    config: { model: claude-4, memory: persistent }
  - type: cron-scheduler
    schedule: "0 9 * * *"
    task: "review overnight alerts"
  - type: dashboard
    port: 3000
```

### 3. @skill → Auto-Tool Registration

DimOS's `@skill` decorator is elegant — annotate a method, it becomes available to any agent. For autonomOS:

```typescript
// Any module can expose capabilities
class MyModule {
  @skill("Search codebase for pattern")
  async searchCode(query: string): Promise<SearchResult[]> { ... }
}
// → automatically available as MCP tool, dashboard action, etc.
```

### 4. Spec Contracts for Plugins

DimOS uses `Protocol` classes to define what a module must implement. For autonomOS plugins:

```typescript
interface AgentSpec {
  startSession(): Promise<SessionId>
  getStatus(): Promise<AgentStatus>
  sendMessage(msg: string): Promise<AgentResponse>
}
// Any plugin implementing AgentSpec can be auto-wired
```

### 5. Transport Abstraction

DimOS swaps LCM/SHM/ROS without changing modules. For autonomOS:
- **Dev path**: WebSocket / HTTP (dashboard ↔ agents)
- **Robot path**: LCM / DDS (low-latency hardware control)
- Same module code, different transport — just swap at config level

## What to Build vs What to Borrow

### Build (autonomOS's job)

| Capability | Why we build it |
|-----------|----------------|
| **Dashboard UI** | DimOS has Rerun/Foxglove but no unified web dashboard. This is our core product. |
| **Multi-agent orchestration** | DimOS handles one robot. We orchestrate many agents across sessions. |
| **Cron / scheduling** | DimOS doesn't have cron. We add scheduled agent execution. |
| **Memory management UI** | DimOS has ChromaDB spatial memory but no UI to browse/edit it. |
| **Cross-session state** | DimOS sessions are ephemeral. We add persistence across sessions. |
| **Agent-agnostic control plane** | DimOS is DimOS-specific. We abstract over OpenClaw + Claude Code + DimOS. |

### Borrow (learn from DimOS)

| Pattern | What we learn |
|---------|---------------|
| **Module graph architecture** | Our core abstraction design |
| **Blueprint composition** | How to define agent configurations |
| **autoconnect algorithm** | How to wire modules without manual config |
| **@skill → MCP pipeline** | How to expose capabilities as tools |
| **Spec protocol matching** | How to do duck-typed plugin interfaces |
| **Transport abstraction** | How to decouple modules from communication |

### Integrate (use DimOS directly)

| For the robot path | How |
|-------------------|-----|
| **Robot control** | Run DimOS as the robot backend |
| **Navigation / SLAM** | Use DimOS's nav stack as-is |
| **Perception** | Use DimOS's spatial memory, object detection |
| **MCP bridge** | autonomOS talks to DimOS via MCP (port 9990) |

The relationship: **autonomOS = mission control layer ABOVE DimOS for robots, ABOVE OpenClaw for dev agents.**

## Integration Architecture (Robot Path)

```
┌─────────────────────────────────────────────┐
│           autonomOS Dashboard               │
│  (observability, scheduling, orchestration) │
└──────────┬──────────────┬───────────────────┘
           │              │
     MCP / API      MCP / API
           │              │
┌──────────▼──────┐  ┌────▼──────────────────┐
│  OpenClaw Agent │  │  DimOS (Robot)         │
│  (reasoning,    │  │  MCPModule:9990        │
│   planning)     │  │  nav, perception,      │
│                 │  │  spatial memory,        │
│                 │  │  motor control          │
└──────────┬──────┘  └────▲──────────────────┘
           │              │
           └──── MCP ─────┘
         (roboclaw plugin)
```

## Integration Architecture (Dev Path)

```
┌─────────────────────────────────────────────┐
│           autonomOS Dashboard               │
│  (agent status, logs, memory, cron, config) │
└──────────┬──────────────┬───────────────────┘
           │              │
     API / Plugin    API / Plugin
           │              │
┌──────────▼──────┐  ┌────▼──────────────────┐
│  OpenClaw       │  │  Claude Code           │
│  (sessions,     │  │  (sessions, hooks,     │
│   cron, memory) │  │   memory)              │
└─────────────────┘  └────────────────────────┘
```

## Open Questions

1. **Should autonomOS adopt DimOS's Module class directly?** Or design our own inspired by it? (Probably our own — TypeScript vs Python, different deployment model)

2. **How deep should the DimOS integration go?** Options:
   - **Shallow**: autonomOS just talks to DimOS via MCP (current roboclaw pattern)
   - **Medium**: autonomOS reads DimOS's internal state (LCM topics, module status)
   - **Deep**: autonomOS deploys and manages DimOS blueprints

3. **Should the dev path and robot path share actual code?** Or just share patterns? (Start with shared patterns, converge if they naturally align)

4. **MCP as the universal interface?** Both DimOS and OpenClaw speak MCP. Should autonomOS standardize on MCP for all agent communication? (Probably yes — it's already the lingua franca)
