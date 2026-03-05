# OpenClaw — Plugin SDK & Extension System

## Overview

OpenClaw's plugin SDK is the primary extensibility mechanism. Plugins can register tools, hooks, channels, HTTP routes, CLI commands, services, and LLM providers. The system supports 42 bundled extensions and user-installed plugins.

## Plugin API (`OpenClawPluginApi`)

The core interface plugins receive during registration:

```typescript
type OpenClawPluginApi = {
  // Identity
  id: string;
  name: string;
  version?: string;
  source: string;

  // Context
  config: OpenClawConfig;              // Full OpenClaw config
  pluginConfig?: Record<string, unknown>; // Plugin-specific config
  runtime: PluginRuntime;              // Runtime utilities
  logger: PluginLogger;               // Logging

  // Registration Methods
  registerTool(tool, opts?): void;         // Agent tools
  registerHook(events, handler, opts?): void; // Lifecycle hooks
  registerHttpRoute(params): void;         // Custom HTTP endpoints
  registerChannel(registration): void;     // Messaging channels
  registerGatewayMethod(method, handler): void; // Gateway RPC
  registerCli(registrar, opts?): void;     // CLI commands
  registerService(service): void;          // Background services
  registerProvider(provider): void;        // LLM providers
  registerCommand(command): void;          // Agent commands

  // Utilities
  resolvePath(input: string): string;      // Resolve relative paths
  on(hookName, handler, opts?): void;      // Typed hook registration
};
```

## Tool Registration

Two patterns:

### Direct Tool Object
```typescript
api.registerTool({
  name: "my_tool",
  description: "Does something useful",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    limit: Type.Optional(Type.Number({ description: "Max results" })),
  }),
  ownerOnly: false,  // false = any sender can use
  async execute(toolCallId, params) {
    const results = await doWork(params.query, params.limit);
    return {
      content: [{ type: "text", text: JSON.stringify(results) }],
      details: { resultCount: results.length },
    };
  },
});
```

### Factory Function (Context-Dependent)
```typescript
api.registerTool(
  (ctx: OpenClawPluginToolContext) => {
    if (ctx.sandboxed) return null;  // Skip in sandbox mode
    return createMyTool(api);        // Return tool or array of tools
  },
  { optional: true, names: ["my_tool"] }
);
```

### Tool Context
The factory receives runtime context:
```typescript
type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  messageChannel?: string;          // telegram, discord, etc.
  agentAccountId?: string;
  requesterSenderId?: string;       // Who triggered this
  senderIsOwner?: boolean;          // Is sender in allowlist?
  sandboxed?: boolean;              // Running in sandbox?
};
```

## Hook System (25 Lifecycle Events)

### Agent Lifecycle
| Hook | When | Can Modify |
|------|------|-----------|
| `before_model_resolve` | Before model selection | Model choice |
| `before_prompt_build` | Before system prompt assembly | Prompt content |
| `before_agent_start` | Before agent executes | System prompt, context, model |
| `llm_input` | Before LLM API call | Observe only |
| `llm_output` | After LLM response | Observe only |
| `agent_end` | After agent completes | Nothing (post-hoc) |

### Session/Message
| Hook | When | Can Modify |
|------|------|-----------|
| `session_start` | New conversation | Nothing |
| `session_end` | Conversation ended | Nothing |
| `message_received` | Inbound message | Nothing |
| `message_sending` | Before outbound | Message content (can cancel) |
| `message_sent` | After outbound | Nothing |

### Tool Execution
| Hook | When | Can Modify |
|------|------|-----------|
| `before_tool_call` | Before tool runs | Can block |
| `after_tool_call` | After tool completes | Nothing |
| `tool_result_persist` | Before result saved | Nothing |

### Memory
| Hook | When | Can Modify |
|------|------|-----------|
| `before_compaction` | Before session compact | Nothing |
| `after_compaction` | After compact complete | Nothing |
| `before_reset` | Before /new or /reset | Nothing |
| `before_message_write` | Before message saved | Can block |

### Subagent
| Hook | When | Can Modify |
|------|------|-----------|
| `subagent_spawning` | Before subagent spawn | Config |
| `subagent_delivery_target` | Configure delivery | Delivery target |
| `subagent_spawned` | After subagent created | Nothing |
| `subagent_ended` | When subagent terminates | Nothing |

### Gateway
| Hook | When | Can Modify |
|------|------|-----------|
| `gateway_start` | Gateway starting | Nothing |
| `gateway_stop` | Gateway stopping | Nothing |

### Hook Registration Example
```typescript
api.on("before_agent_start", async (event, ctx) => {
  // Inject context before agent runs
  const memories = await searchRelevantMemories(event.prompt);
  return {
    prependContext: formatMemories(memories),
    modelOverride: "claude-sonnet-4-6",  // Optional
  };
}, { priority: 100 });  // Higher priority runs first
```

## Plugin Module Structure

### Package Layout
```
my-plugin/
├── package.json              # With openclaw.extensions field
├── openclaw.plugin.json      # Plugin metadata (optional)
├── src/
│   └── index.ts              # Main entry point
└── ...
```

### package.json
```json
{
  "name": "@my-org/openclaw-plugin",
  "type": "module",
  "dependencies": {
    "@sinclair/typebox": "0.34.48"
  },
  "openclaw": {
    "extensions": ["./src/index.ts"]
  }
}
```

### Plugin Export (Two Forms)

**Definition Object:**
```typescript
export default {
  id: "my-plugin",
  name: "My Plugin",
  configSchema: mySchema,     // Zod or JSON Schema
  register(api: OpenClawPluginApi) {
    api.registerTool(...);
    api.registerHook(...);
  },
  activate(api: OpenClawPluginApi) {
    // Optional: startup tasks
  },
};
```

**Register Function:**
```typescript
export default function register(api: OpenClawPluginApi) {
  api.registerTool(...);
  api.on("agent_end", handler);
}
```

## Plugin Discovery & Loading

### Discovery Locations (in priority order)
1. **Bundled** — `dist/extensions/` (core plugins, highest priority)
2. **Config** — `~/.openclaw/extensions/` (user-installed)
3. **Workspace** — `./extensions/` (in monorepo)
4. **Custom paths** — Via `config.plugins.loadPaths` or `OPENCLAW_PLUGIN_LOAD_PATHS`

### Loading Mechanism
- **Jiti** (TypeScript/JavaScript JIT loader) for dynamic loading
- Alias mapping: `openclaw/plugin-sdk/*` → source files
- Manifest registry caches plugin metadata
- Provenance tracking prevents duplicate loading

### Enable/Disable
```json
{
  "plugins": {
    "enabled": true,
    "allow": "all",
    "entries": {
      "plugin-id": { "enabled": false }
    },
    "slots": {
      "memory": "memory-lancedb"
    },
    "loadPaths": ["~/custom-plugins"]
  }
}
```

## Plugin Runtime (Available Utilities)

Plugins get access to OpenClaw internals via `api.runtime`:

```typescript
type PluginRuntime = {
  version: string;

  config: {
    loadConfig(): OpenClawConfig;
    writeConfigFile(patch): void;
  };

  system: {
    enqueueSystemEvent(text, options): void;
    requestHeartbeatNow(sessionKey): void;
    runCommandWithTimeout(cmd, timeout): Promise<Result>;
  };

  media: {
    loadWebMedia(url): Promise<Buffer>;
    detectMime(buffer): string | null;
    resizeToJpeg(buffer, opts): Promise<Buffer>;
    getImageMetadata(path): Promise<Metadata>;
  };

  tts: {
    textToSpeechTelephony(text, voice): Promise<Buffer>;
  };

  stt: {
    transcribeAudioFile(path): Promise<string>;
  };

  tools: {
    createMemoryGetTool(...): AnyAgentTool;
    createMemorySearchTool(...): AnyAgentTool;
  };

  events: {
    onAgentEvent(callback): void;
    onSessionTranscriptUpdate(callback): void;
  };

  logging: {
    shouldLogVerbose(): boolean;
    getChildLogger(name): Logger;
  };

  state: {
    resolveStateDir(): string;
  };
};
```

## Plugin Config Schema

Plugins can declare configuration with validation and UI hints:

```typescript
const configSchema = z.object({
  apiKey: z.string(),
  model: z.string().default("text-embedding-3-small"),
  autoRecall: z.boolean().default(true),
  maxChars: z.number().default(1000),
});

// With UI hints for the Control UI
const uiHints = {
  apiKey: { label: "API Key", sensitive: true, placeholder: "sk-..." },
  model: { label: "Embedding Model", help: "e.g., text-embedding-3-small" },
};
```

## Plugin Security

### Sandbox Detection
```typescript
api.registerTool((ctx) => {
  if (ctx.sandboxed) return null;  // Skip dangerous tools in sandbox
  return createDangerousTool();
});
```

### Owner-Only Tools
```typescript
{ name: "admin_tool", ownerOnly: true, execute: ... }
// Only senders in the DM allowlist can invoke
```

### Path Validation
- Symlink safety checks (no path escapes)
- UID ownership verification on Unix
- World-writable directory rejection

## Plugin Registry (Runtime State)

After all plugins load, the registry contains:

```typescript
type PluginRegistry = {
  plugins: PluginRecord[];            // Metadata per plugin
  tools: PluginToolRegistration[];    // All registered tools
  hooks: PluginHookRegistration[];    // All lifecycle hooks
  channels: PluginChannelRegistration[]; // Channel integrations
  providers: PluginProviderRegistration[]; // LLM providers
  httpRoutes: PluginHttpRouteRegistration[]; // HTTP endpoints
  cliRegistrars: PluginCliRegistration[];  // CLI commands
  services: PluginServiceRegistration[];   // Background services
  commands: PluginCommandRegistration[];   // Agent commands
  gatewayHandlers: GatewayRequestHandlers; // Gateway RPC
  diagnostics: PluginDiagnostic[];  // Health checks
};
```

## Concrete Examples

### Example 1: Tool Plugin (Lobster)
```typescript
// extensions/lobster/index.ts
export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    ((ctx) => {
      if (ctx.sandboxed) return null;
      return {
        name: "lobster",
        description: "Run Lobster pipelines",
        parameters: Type.Object({
          action: Type.Unsafe({ type: "string", enum: ["run", "resume"] }),
          pipeline: Type.Optional(Type.String()),
        }),
        async execute(id, params) {
          // Validate, spawn process, return result
          return { content: [...], details: envelope };
        },
      };
    }),
    { optional: true }
  );
}
```

### Example 2: Memory Plugin (LanceDB)
```typescript
// extensions/memory-lancedb/index.ts — simplified
export default {
  id: "memory-lancedb",
  kind: "memory",
  configSchema: memoryConfigSchema,
  register(api) {
    // Tools
    api.registerTool({ name: "memory_recall", ... });
    api.registerTool({ name: "memory_store", ... });

    // CLI
    api.registerCli(({ program }) => {
      program.command("ltm").command("search").action(async (q) => {...});
    });

    // Auto-recall before agent start
    api.on("before_agent_start", async (event) => {
      const results = await db.search(event.prompt, 3);
      return { prependContext: formatMemories(results) };
    });

    // Auto-capture after conversation
    api.on("agent_end", async (event) => {
      await extractAndStoreMemories(event.transcript);
    });
  }
};
```

### Example 3: Channel Plugin (Discord)
```typescript
// extensions/discord/index.ts
export default {
  id: "discord",
  name: "Discord",
  register(api: OpenClawPluginApi) {
    setDiscordRuntime(api.runtime);
    api.registerChannel({ plugin: discordPlugin });
    registerDiscordSubagentHooks(api);
  }
};
```

## MCP Support

OpenClaw does **not** natively support MCP (Model Context Protocol). However:
- The roboclaw plugin (dimensionalOS) demonstrates bridging MCP tools into OpenClaw via the plugin SDK
- The plugin SDK's `registerTool()` can wrap any MCP tool as an OpenClaw tool
- Pattern: MCP client → discover tools → register each via `api.registerTool()`

## Takeaway for autonomOS

1. **Plugin SDK is our primary extension point.** An `autonomos` OpenClaw plugin could register hooks, HTTP routes, and gateway methods to expose exactly the observability data we need.

2. **25 lifecycle hooks** are extremely valuable for observability. `agent_end` gives us completed turn data, `message_received`/`message_sent` give us message flow, `before_agent_start` lets us inject context.

3. **The plugin system is the right integration path** — not forking, not middleware, not CLI scraping. A plugin runs inside the gateway process and has full access to the runtime.

4. **Config schema with UI hints** means our dashboard could render plugin config forms automatically — useful for the "configuration" part of autonomOS.
