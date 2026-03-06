# LangGraph

**By:** LangChain
**License:** MIT
**Language:** Python, TypeScript (JS)
**Repo:** https://github.com/langchain-ai/langgraph
**Docs:** https://langchain-ai.github.io/langgraph/

## What It Is

A framework for building stateful, multi-step agent workflows as directed graphs. Nodes are computation steps (LLM calls, tool executions, custom logic), edges are transitions (including conditional routing based on state).

Built on top of LangChain but can be used with minimal LangChain dependencies.

## Core Concepts

- **StateGraph**: Define a typed state object that flows through the graph. Each node can read/write to it.
- **Nodes**: Functions that take state, do work (call LLM, run tool, custom logic), return updated state.
- **Edges**: Connections between nodes. Can be static or conditional (routing based on state).
- **Checkpointing**: Built-in persistence — save/restore graph state at any point. Enables time-travel debugging and human-in-the-loop.
- **Subgraphs**: Compose graphs within graphs for multi-agent architectures.

## Architecture Pattern

```
User Input
    |
    v
[Agent Node] --tool_call--> [Tool Node] --result--> [Agent Node]
    |                                                     |
    | (no tool call)                                      |
    v                                                     |
  [END] <-------------------------------------------------+
```

The classic ReAct loop, but explicit as a graph.

## Strengths

- **Fine-grained control**: You decide exactly how agents route, retry, and recover
- **Model-agnostic**: Any LLM provider (OpenAI, Anthropic, Google, Ollama, etc.)
- **Persistence**: First-class checkpointing with multiple backends (SQLite, Postgres, Redis)
- **Human-in-the-loop**: Interrupt graph execution, get human input, resume
- **Streaming**: Token-level and step-level streaming out of the box
- **LangSmith integration**: Tracing, evaluation, monitoring (paid product)
- **Mature ecosystem**: Large community, many examples, active development

## Weaknesses

- **Verbose**: Defining graphs manually is boilerplate-heavy compared to "just give the model tools"
- **Abstraction overhead**: LangChain's layered abstractions can be hard to debug
- **Learning curve**: Understanding state management, reducers, and graph composition takes time
- **Opinionated about state**: The state-passing pattern doesn't suit every use case

## Relevance to autonomOS

### As an integration target (HIGH)
LangGraph has a **callbacks system** and **LangSmith tracing** that emit structured events for every step. autonomOS could:
- Subscribe to LangGraph callbacks to observe agent execution in real-time
- Parse LangSmith traces for historical analysis
- Provide a "LangGraph adapter" in `packages/core`

### As an internal tool (MEDIUM)
Could use LangGraph for autonomOS's own orchestration if we need multi-step agent workflows internally. But for simple tool-use loops, Claude Agent SDK is lighter.

### Key patterns to adopt
- **Checkpointing/persistence model** — good inspiration for our session management
- **Conditional routing** — useful pattern for multi-agent delegation
- **Streaming architecture** — their approach to step-level streaming is well-designed

## Integration Hooks

| Hook | Description | autonomOS Use |
|------|-------------|---------------|
| Callbacks | `on_llm_start`, `on_tool_start`, `on_chain_end`, etc. | Real-time observability |
| LangSmith API | REST API for traces, runs, feedback | Historical analysis |
| Checkpoints | State snapshots at each step | Session replay |
| Custom nodes | Inject autonomOS reporting as a graph node | Embedded monitoring |
