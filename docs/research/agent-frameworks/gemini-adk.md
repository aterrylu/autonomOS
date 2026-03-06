# Gemini ADK (Agent Development Kit)

**By:** Google
**License:** Apache 2.0
**Language:** Python (primary), Java
**Repo:** https://github.com/google/adk-python
**Docs:** https://google.github.io/adk-docs/

## What It Is

Google's framework for building AI agents powered by Gemini models. Supports hierarchical multi-agent systems, tool orchestration, session management, and memory. Designed to work within the Google Cloud ecosystem (Vertex AI, Cloud Run) but can run locally.

## Core Concepts

- **Agent**: An LLM-powered entity with instructions, tools, and optional sub-agents
- **Tool**: Functions, API calls, or other agents that an agent can invoke
- **Session**: Conversation state with built-in persistence (in-memory, Firestore, Vertex AI)
- **Memory**: Long-term storage across sessions (Vertex AI Search or custom backends)
- **Runner**: Executes agents, manages the tool-use loop
- **Callbacks**: Before/after hooks for agent actions, tool calls, and model invocations
- **Artifacts**: File/blob management within sessions (images, documents, etc.)

## Architecture Pattern

```
User Message
    |
    v
+---------------------------+
|  Root Agent               |
|    |                      |
|    +-- Sub-Agent A        |
|    |     +-- Tool 1       |
|    |     +-- Tool 2       |
|    |                      |
|    +-- Sub-Agent B        |
|          +-- Tool 3       |
+---------------------------+
    |
    v
  Response
```

Hierarchical delegation — root agent routes to sub-agents, which can route further.

## Strengths

- **Multi-agent built-in**: Hierarchical agent delegation is a first-class concept
- **Multi-modal**: Audio/video streaming agents (bidirectional), not just text
- **Session & memory**: Built-in persistence with multiple backends
- **Google ecosystem**: Native Vertex AI deployment, Cloud Run hosting, Firestore storage
- **Artifact management**: Handle files/blobs within agent sessions
- **Evaluation framework**: Built-in tools for testing agent quality

## Weaknesses

- **Google-centric**: Best experience requires Google Cloud. Local-only is possible but loses features
- **Primarily Gemini**: Other models supported but Gemini is the first-class citizen
- **Newer**: Less battle-tested than LangGraph, smaller community
- **Heavier**: More opinionated and complex than Claude Agent SDK
- **Python-first**: TypeScript/JS support is limited compared to LangGraph

## Relevance to autonomOS

### As an integration target (MEDIUM)
If users run agents built with Gemini ADK, autonomOS should observe them. Integration points:
- **Callbacks**: `before_agent_callback`, `after_agent_callback`, `before_tool_callback`, etc.
- **Session service**: Custom session service implementation could report to autonomOS
- **Artifacts**: Track file/blob creation and usage

### As an internal tool (LOW)
Less relevant than Claude Agent SDK for our use case — we're Claude-native. But worth understanding for:
- Multi-agent patterns (hierarchical delegation)
- Audio/video agent capabilities (future robot path)
- Session/memory architecture

### Key patterns to adopt
- **Hierarchical multi-agent model** — good inspiration for orchestrating multiple agents
- **Artifact management** — autonomOS should track files/outputs agents create
- **Evaluation framework** — agent quality testing is something autonomOS could offer
- **Audio/video agents** — relevant for the robot path (camera feeds, voice commands)

## Integration Hooks

| Hook | Description | autonomOS Use |
|------|-------------|---------------|
| `before_agent_callback` | Before agent processes | Track agent invocations |
| `after_agent_callback` | After agent completes | Capture results, latency |
| `before_tool_callback` | Before tool execution | Tool monitoring |
| `after_tool_callback` | After tool execution | Error tracking |
| Custom SessionService | Pluggable session storage | Session observability |
| Custom MemoryService | Pluggable memory backend | Knowledge tracking |
