# MCP Protocol & Agent Integration

> Source: `~/workspace/dimos/dimos/protocol/mcp/`, `~/workspace/dimos/dimos/agents/`
> Key files: `mcp.py`, `bridge.py`, `agent.py`, `annotation.py`

## Overview

DimOS has two agent integration paths:
1. **Internal agent** — a LangGraph-based `Agent` module that runs inside the DimOS process, subscribes to perception streams, and calls skills via RPC
2. **External agent via MCP** — an `MCPModule` that exposes robot skills as MCP tools over TCP, allowing any MCP client (OpenClaw, Claude Code) to control the robot

Both paths use the same skill system — `@skill`-decorated methods on modules.

## The @skill Decorator

**File:** `dimos/agents/annotation.py`

```python
def skill(func):
    func.__rpc__ = True    # makes it callable via RPC
    func.__skill__ = True  # marks it as an agent-visible tool
    return func
```

Any module method decorated with `@skill` becomes:
- An RPC method (callable from other modules)
- A discoverable tool (listed by `get_skills()`)
- An MCP tool (exposed via MCPModule)
- A LangChain tool (used by the internal Agent)

### Skill Discovery

**`Module.get_skills()`** (`dimos/core/module.py:384-395`):

```python
@rpc
def get_skills(self) -> list[SkillInfo]:
    skills = []
    for name in dir(self):
        attr = getattr(self, name)
        if callable(attr) and hasattr(attr, "__skill__"):
            schema = json.dumps(tool(attr).args_schema.model_json_schema())
            skills.append(SkillInfo(
                class_name=self.__class__.__name__,
                func_name=name,
                args_schema=schema   # JSON Schema string
            ))
    return skills
```

## Available Robot Skills

### Unitree Skill Container (`dimos/robot/unitree/unitree_skill_container.py`)

| Skill | Parameters | What it does |
|-------|-----------|--------------|
| `relative_move` | `forward`, `left`, `degrees` | Navigate relative to current position |
| `execute_sport_command` | `command_name` | FrontPounce, Handstand, Dance1, etc. |
| `wait` | `seconds` | Pause execution |
| `current_time` | — | Return system time |
| `observe` | — | Return latest camera frame |

### GO2 Connection Skills (`dimos/robot/unitree/go2/connection.py`)

| Skill | Parameters | What it does |
|-------|-----------|--------------|
| `move` | `twist`, `duration` | Send Twist velocity command |
| `standup` | — | Stand the robot up |
| `liedown` | — | Lie the robot down |
| `observe` | — | Get latest video frame |

### Navigation Skills (`dimos/agents/skills/navigation.py`)

| Skill | Parameters | What it does |
|-------|-----------|--------------|
| `tag_location` | `location_name` | Store current location in spatial memory |
| `navigate_with_text` | `query` | Navigate to location by text description |
| `go_to_absolute` | `x`, `y`, `yaw` | Navigate to absolute coordinates |
| `relative_nav` | `forward`, `left`, `yaw` | Navigate relative |

### Manipulation Skills (`dimos/manipulation/manipulation_module.py`)

| Skill | What it does |
|-------|--------------|
| `open_gripper` / `close_gripper` / `set_gripper` | Gripper control |
| `move_to_pose` | Move to Cartesian pose |
| `move_to_joints` | Move to joint targets |
| `scan_objects` | Scan environment for objects |
| `pick` / `place` | Pick and place objects |

## MCPModule — The TCP Server

**File:** `dimos/protocol/mcp/mcp.py`

### Startup

MCPModule starts a TCP server on `0.0.0.0:9990`:

```python
def _start_server(self, port=9990):
    async def handle_client(reader, writer):
        while True:
            data = await reader.readline()
            if not data: break
            response = await self._handle_request(json.loads(data.decode()))
            writer.write(json.dumps(response).encode() + b"\n")
            await writer.drain()

    self._server = await asyncio.start_server(handle_client, "0.0.0.0", port)
```

### Skill Registration

When `on_system_modules()` is called (after all modules deploy):

```python
@rpc
def on_system_modules(self, modules: list[RPCClient]) -> None:
    self._skills = [skill for module in modules for skill in (module.get_skills() or [])]
    self._rpc_calls = {
        skill.func_name: RpcCall(None, self.rpc, skill.func_name, skill.class_name, [])
        for skill in self._skills
    }
```

This collects all `@skill` methods from all modules in the blueprint and creates RPC call wrappers.

### JSON-RPC Message Handling

Three MCP methods are supported:

**`initialize`** — protocol handshake:
```json
{"protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
 "serverInfo": {"name": "dimensional", "version": "1.0.0"}}
```

**`tools/list`** — returns all registered skills as MCP tools:
```json
{"tools": [{"name": "relative_move", "description": "...", "inputSchema": {...}}]}
```

**`tools/call`** — executes a skill:
- Looks up `RpcCall` by tool name
- Executes via `run_in_executor()` (non-blocking)
- Returns text content result or error

### Error Handling
- Unknown tool name → JSON-RPC error `-32602`
- Unknown method → JSON-RPC error `-32601`
- Execution exception → caught and returned as error text

## MCP Bridge for Claude Code

**File:** `dimos/protocol/mcp/bridge.py`

A stdio-to-TCP bridge that lets Claude Code use DimOS as an MCP server:

```bash
claude mcp add --transport stdio dimos --scope project -- python -m dimos.protocol.mcp
```

Bridge reads JSON-RPC from stdin, forwards to TCP:9990, returns response to stdout. This means Claude Code can directly call `relative_move`, `navigate_with_text`, etc.

## Internal Agent — LangGraph Integration

**File:** `dimos/agents/agent.py`

The `Agent` module is a full LLM reasoning loop that runs inside DimOS:

```python
class Agent(Module):
    agent: Out[BaseMessage]       # publishes agent thinking
    human_input: In[str]          # subscribes to human queries
    agent_idle: Out[bool]         # publishes idle status
```

### Startup

```python
@rpc
def on_system_modules(self, modules):
    tools = _get_tools_from_modules(self, modules, self.rpc)
    self._state_graph = create_agent(
        model="gpt-4o",
        tools=tools,
        system_prompt=self.config.system_prompt,
    )
    self._thread.start()
```

### Skill → LangChain Tool Conversion

```python
def _skill_to_tool(agent, skill, rpc):
    rpc_call = RpcCall(None, rpc, skill.func_name, skill.class_name, [])

    def wrapped_func(*args, **kwargs):
        result = rpc_call(*args, **kwargs)
        if hasattr(result, "agent_encode"):
            agent.add_message(HumanMessage(content=[...]))  # vision
        return str(result)

    return StructuredTool(
        name=skill.func_name,
        func=wrapped_func,
        args_schema=json.loads(skill.args_schema),
    )
```

### Agent Loop
- Consumes messages from `human_input` queue
- Runs LangGraph state machine with streamed updates
- Publishes responses to `agent` output stream
- Supports multi-step tool execution (agent calls skill, observes result, plans next step)

## Complete Data Flow: "Move forward 1 meter"

```
User → OpenClaw CLI
  └→ openclaw agent --message "move forward 1 meter"
     └→ LLM reasons → decides to call relative_move(forward=1.0)
        └→ roboclaw plugin: callTool("relative_move", {forward: 1.0})
           └→ TCP connect to localhost:9990
              └→ JSON-RPC: initialize → tools/call
                 └→ MCPModule._handle_request()
                    └→ RpcCall("relative_move") via LCM RPC
                       └→ UnitreeSkillContainer.relative_move(forward=1.0)
                          ├→ Get current pose via TF: world → base_link
                          ├→ Compute goal pose (1m ahead)
                          ├→ NavigationInterface.set_goal(goal_pose)
                          │   └→ A* planner computes path
                          │      └→ Publishes Twist commands to cmd_vel
                          │         └→ GO2Connection.move(twist)
                          │            └→ WebRTC → robot motors
                          └→ Poll NavigationInterface.get_state()
                             └→ FOLLOWING_PATH → GOAL_REACHED
                                └→ Return "Navigation goal reached"
                                   └→ JSON-RPC response → TCP → roboclaw → OpenClaw → User
```

## Agentic Blueprint Composition

The MCP-enabled blueprint is just one line of composition:

```python
# unitree_go2_agentic_mcp.py
unitree_go2_agentic_mcp = autoconnect(
    unitree_go2_agentic,      # robot + agent + skills
    MCPModule.blueprint(),     # adds MCP TCP server
)
```

Where `unitree_go2_agentic` itself is:
```python
unitree_go2_agentic = autoconnect(
    unitree_go2_spatial,      # robot connection + spatial perception
    agent(),                   # LangGraph agent module
    _common_agentic,          # skill modules
)

_common_agentic = autoconnect(
    navigation_skill(),        # tag/navigate locations
    person_follow_skill(),     # follow people
    unitree_skills(),          # sport commands + movement
    web_input(),               # human input via web UI
    speak_skill(),             # TTS
)
```

## Takeaway for autonomOS

1. **@skill → MCP tool is automatic.** Annotate a method, and it's available to any agent. We should adopt this exact pattern.

2. **MCPModule is ~200 lines.** The entire TCP server + JSON-RPC + skill discovery + tool routing is surprisingly small. MCP does the heavy lifting.

3. **Two agent paths (internal + external) share the same skills.** Whether the agent runs inside DimOS (LangGraph) or outside (OpenClaw/Claude Code), it calls the same `@skill` methods. This is the right architecture — skills are independent of the agent runtime.

4. **The data flow trace shows clean separation:** Agent reasoning ↔ MCP protocol ↔ Skill execution ↔ Robot control. Each layer is independent and swappable.

5. **For autonomOS robot path:** We don't need to build a robot framework — we integrate with DimOS. Our job is the mission control layer above: observability, scheduling, multi-agent orchestration.
