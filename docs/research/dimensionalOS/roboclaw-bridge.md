# roboclaw — OpenClaw ↔ DimOS Bridge

> Source: [dimensionalOS/roboclaw](https://github.com/dimensionalOS/roboclaw) (TypeScript, 10 commits)

## What It Does

roboclaw is an **OpenClaw plugin** that discovers MCP tools from a running DimOS instance and registers them as OpenClaw agent tools. This lets you say `"move forward 10 meters"` in OpenClaw and have a physical robot execute it.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│  Terminal 1: DimOS Backend                             │
│                                                        │
│  dimos run unitree-go2-agentic-mcp                     │
│       │                                                │
│       ├── Robot hardware driver (Unitree Go2)          │
│       ├── Navigation, perception, spatial memory       │
│       └── MCPModule → TCP server on localhost:9990     │
└──────────────────────────┬─────────────────────────────┘
                           │ JSON-RPC over TCP
┌──────────────────────────▼─────────────────────────────┐
│  Terminal 2: OpenClaw Frontend                         │
│                                                        │
│  openclaw gateway run --port 18789                     │
│       │                                                │
│       ├── Loads roboclaw plugin (openclaw.plugin.json) │
│       ├── Plugin discovers MCP tools from DimOS        │
│       └── Registers them as OpenClaw agent tools       │
│                                                        │
│  openclaw agent --message "move forward 10 meters"     │
│       └── Agent reasons → calls registered tool        │
│           → roboclaw forwards to DimOS via TCP         │
└────────────────────────────────────────────────────────┘
```

## How the Plugin Works (Source Analysis)

The entire bridge is a single `index.ts` (~180 lines). Here's the flow:

### 1. Plugin Registration

```typescript
export default {
  id: "dimos",
  name: "Dimos MCP Bridge",
  register(api: OpenClawPluginApi) {
    // Discover tools synchronously at startup
    const mcpTools = discoverToolsSync(host, port);
    // Register each as an OpenClaw tool
    for (const mcpTool of mcpTools) {
      api.registerTool(tool, { name: mcpTool.name });
    }
  }
}
```

### 2. Tool Discovery (Synchronous)

On plugin load, it spawns a child Node process that:
1. Opens a TCP connection to `localhost:9990`
2. Sends MCP `initialize` handshake
3. Sends `tools/list` request
4. Returns the tool definitions as JSON

This is synchronous (blocks the main thread) so tools are available immediately when the agent starts.

### 3. Tool Execution (Async)

When the agent calls a tool:
1. Opens a new TCP connection to DimOS
2. Sends MCP `initialize` + `tools/call` with the tool name and args
3. Waits for response (30s timeout)
4. Returns the text content to the agent

### 4. Schema Translation

MCP tool schemas (JSON Schema) are converted to TypeBox schemas for OpenClaw's type system:

```typescript
// MCP: { "type": "number", "description": "Distance in meters" }
// → TypeBox: Type.Number({ description: "Distance in meters" })
```

## Plugin Config

```json
{
  "id": "dimos",
  "name": "Dimensional MCP Bridge",
  "configSchema": {
    "properties": {
      "mcpHost": { "type": "string", "description": "defaults to 127.0.0.1" },
      "mcpPort": { "type": "number", "description": "defaults to 9990" }
    }
  }
}
```

## Setup Commands

```bash
# Terminal 1 — start robot backend
uv sync
uv run dimos run unitree-go2-agentic-mcp

# Terminal 2 — start agent frontend
pnpm install
pnpm openclaw config set plugins.entries.dimos.enabled true
pnpm openclaw gateway stop && pnpm openclaw gateway run --port 18789 --verbose gateway.mode=local
pnpm openclaw agent --session-id dimos-test --message "move forward 10 meters"
```

## Key Takeaways for autonomOS

1. **MCP is the lingua franca** — DimOS exposes skills as MCP tools, OpenClaw consumes them. This is a proven pattern we should adopt.

2. **Plugin SDK pattern** — OpenClaw has a clean plugin API (`OpenClawPluginApi`) with `registerTool()`. We should study this for our own extensibility model.

3. **The bridge is thin** — Only ~180 lines. The hard work is in DimOS (robot control) and OpenClaw (agent reasoning). The bridge just translates protocols.

4. **Synchronous discovery, async execution** — Tools are discovered at startup (blocking) so they're available immediately. Execution is async with timeouts. Good pattern.

5. **No persistent connection** — Each tool call opens a fresh TCP connection. Simple but not ideal for high-frequency robot control. Fine for high-level commands.

6. **No license on roboclaw** — Can't use this code directly. But the pattern (MCP bridge as OpenClaw plugin) is what matters, and that's just a protocol integration.
