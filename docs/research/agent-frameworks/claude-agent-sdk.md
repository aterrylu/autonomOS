# Claude Agent SDK

**By:** Anthropic
**License:** MIT
**Language:** Python, TypeScript
**Repo:** https://github.com/anthropics/claude-agent-sdk
**Docs:** https://docs.anthropic.com/en/docs/agents/agent-sdk

## What It Is

Anthropic's thin, opinionated SDK for building agentic applications with Claude. The core idea: give Claude tools, let it call them in a loop until the task is done. Minimal framework — ~500 lines of core logic.

## Core Concepts

- **Agent**: A configured Claude instance with a system prompt, tools, and optional guardrails
- **Tool**: A function the agent can call (Python function or MCP server)
- **Turn**: One round of agent reasoning + tool calls + tool results
- **Hooks**: Lifecycle callbacks (`on_tool_start`, `on_tool_end`, `on_turn_end`, etc.)
- **Guardrails**: Input/output validators that can block or modify agent behavior
- **Handoffs**: Agent-to-agent delegation (basic multi-agent support)

## Architecture Pattern

```
User Message
    |
    v
+-------------------+
|   Agent Loop      |
|                   |
|  Claude call ---->  tool execution
|       ^                  |
|       +------ result ----+
|                   |
|  (no tool calls)  |
|       |           |
+-------v-----------+
    |
  Response
```

Dead simple. The SDK just manages the loop, tool dispatch, and message history.

## Strengths

- **Minimal**: Easy to understand, debug, and extend. No hidden magic
- **First-class tool use**: Designed around Claude's native tool calling
- **MCP support**: Can connect to any MCP server as a tool source
- **Guardrails built-in**: Input/output validation without external libraries
- **Hooks**: Clean lifecycle events for monitoring
- **Handoffs**: Basic multi-agent delegation (agent A can hand off to agent B)

## Weaknesses

- **Claude-only**: No model-agnostic option
- **No built-in persistence**: You manage conversation history yourself
- **No graph/routing**: The agent decides everything — no explicit control flow
- **New**: Smaller ecosystem and fewer examples than LangGraph
- **Limited orchestration**: Handoffs are basic compared to LangGraph's graph composition

## Relevance to autonomOS

### As an integration target (HIGH)
The **hooks system** is a clean integration point. autonomOS could:
- Register hooks to capture every tool call, response, and handoff
- Build a "Claude Agent SDK adapter" that reports to our control plane
- Monitor token usage, latency, and error rates per agent

### As an internal tool (HIGH)
If autonomOS builds its own agents (e.g., an agent that monitors other agents), the Claude Agent SDK is the natural choice:
- Lightweight, no framework overhead
- Native Claude integration (which we're already using)
- MCP support aligns with our architecture

### Key patterns to adopt
- **Hooks model** — clean, non-intrusive observability. Our adapters should follow this pattern
- **Guardrails** — autonomOS could provide guardrails-as-a-service for managed agents
- **Handoffs** — inform our multi-agent orchestration design

## Integration Hooks

| Hook | Description | autonomOS Use |
|------|-------------|---------------|
| `on_tool_start` | Before tool execution | Real-time tool monitoring |
| `on_tool_end` | After tool execution | Latency tracking, error detection |
| `on_turn_start/end` | Each reasoning cycle | Step-level observability |
| `on_handoff` | Agent-to-agent delegation | Multi-agent flow tracking |
| Guardrails | Input/output validation | Policy enforcement |
