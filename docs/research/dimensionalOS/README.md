# dimensionalOS

**Type:** Integration target + inspiration (robot path)
**Org:** [github.com/dimensionalOS](https://github.com/dimensionalOS)
**Main repo:** [dimensionalOS/dimos](https://github.com/dimensionalOS/dimos) — Python, 110 stars, Apache 2.0
**OpenClaw bridge:** [dimensionalOS/roboclaw](https://github.com/dimensionalOS/roboclaw) — TypeScript, 3 stars, **no license**
**Company:** Dimensional Inc. (2025–present)
**Local checkout:** `~/workspace/dimos/`, `~/workspace/roboclaw/`

## What It Is

DimOS is an **agent-native operating system for generalist robotics**. A Python SDK (~1200 files, 33 packages) for controlling any robot through a unified module-based architecture — no ROS required. Every subsystem (cameras, lidar, motors, AI agents, navigation, spatial memory) is a `Module` with typed `In[T]`/`Out[T]` streams. Blueprints compose modules declaratively. `autoconnect()` wires them by matching stream names and types.

The "roboclaw" repo bridges DimOS to OpenClaw via MCP, making robots controllable through natural language.

## Why We Care

| Pattern from DimOS | Relevance to autonomOS |
|---------------------|----------------------|
| **Module = typed node with In/Out streams** | Core abstraction for our agent/resource model — agents, dashboards, cron schedulers as modules |
| **Blueprint = declarative composition** | How we compose agent workflows and robot configs |
| **autoconnect() by name+type** | Smart wiring for dashboard's agent-to-resource connections |
| **Spec protocol = interface contracts** | How modules declare dependencies without coupling — we need this for plugin interop |
| **MCP as agent↔hardware bridge** | Exact pattern for robot path: expose skills as MCP tools, any agent can call them |
| **@skill decorator → MCP tools** | Automatic tool registration from annotated methods — adoptable pattern |
| **LangGraph agent as Module** | Agent reasoning loop integrated into the module graph, subscribes to perception |
| **OpenClaw plugin SDK** | Reference implementation for how we integrate with OpenClaw |
| **Simulation + replay modes** | Dev without hardware. MuJoCo sim + recorded data replay |
| **Distributed execution (Dask)** | Modules run on separate workers, communicate via LCM/SHM — scalability pattern |
| **Spatial memory (ChromaDB RAG)** | Robot equivalent of agent memory — persistent, queryable, temporal |

## Investigation Checklist

- [x] Architecture overview — module system, blueprints, transports, autoconnect, specs
- [x] Stream system — typed In/Out, pub/sub, state machine, observables
- [x] Blueprint composition — autoconnect algorithm, remapping, requirement checks
- [x] Transport layer — LCM, SHM, ROS, DDS, transport selection logic
- [x] Agent integration — LangGraph loop, skill-to-tool conversion, MCP bridge
- [x] MCP protocol — TCP server, JSON-RPC handling, skill discovery, tool routing
- [x] OpenClaw integration — roboclaw plugin source analysis, data flow trace
- [x] Navigation stack — A* replanning, ROS Nav, frontier exploration
- [x] Perception pipeline — spatial memory, object tracking, 3D detection, VLMs
- [x] Hardware support — Unitree Go2/G1/B1, XArm, Piper, drones, sensors
- [x] Simulation & replay — MuJoCo, recorded data, mock connections
- [x] CLI & configuration — `dimos run`, GlobalConfig, env vars, precedence
- [x] Spec system — protocol interfaces, structural/annotation compliance
- [x] Licensing — Apache 2.0 (dimos), no license (roboclaw)

## Deep Dives

- [**Architecture & Module System**](./architecture.md) — Module base class, typed streams, blueprints, autoconnect, transports, specs, Dask deployment
- [**MCP & Agent Integration**](./mcp-and-agents.md) — MCPModule implementation, @skill decorator, LangGraph agent, skill-to-tool pipeline, complete data flow trace
- [**OpenClaw Integration (roboclaw)**](./roboclaw-bridge.md) — Plugin source analysis, schema translation, discovery/execution protocol
- [**Hardware & Capabilities**](./hardware.md) — Supported robots, sensors, simulation, replay, nav stack, perception, spatial memory
- [**autonomOS Integration Analysis**](./autonomos-integration.md) — Concept mapping, patterns to adopt, what to build vs what to borrow
- [**Licensing & Commercial Use**](./licensing.md) — Apache 2.0 analysis, roboclaw gap, dependency licenses
