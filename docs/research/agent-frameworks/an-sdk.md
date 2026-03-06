# AN SDK (Agent-Native SDK)

**By:** 21st.dev
**License:** MIT
**Language:** TypeScript / React
**Repo:** https://github.com/21st-dev/an-sdk
**Docs:** https://21st.dev/docs/an-sdk

## What It Is

A React component library designed to be "agent-native" — UI components that agents can discover, understand, and interact with programmatically. Not an agent framework; it's a **UI layer** that bridges human UIs and agent UIs.

## Core Concepts

- **Agent-Native Components**: React components with built-in metadata that describes their purpose, inputs, and actions to agents
- **Component Discovery**: Agents can query what components exist and what they do
- **Programmatic Interaction**: Agents can fill forms, click buttons, read state — all via structured API rather than screen scraping
- **Human + Agent UX**: Same components work for both human users (visual) and agents (programmatic)

## Architecture Pattern

```
+------------------+     +------------------+
|  Human User      |     |  AI Agent        |
|  (visual UI)     |     |  (programmatic)  |
+--------+---------+     +--------+---------+
         |                         |
         v                         v
+------------------------------------------+
|        AN SDK Components                 |
|  (self-describing, interactable by both) |
+------------------------------------------+
         |
         v
+------------------------------------------+
|        Application Logic                 |
+------------------------------------------+
```

## Strengths

- **Novel concept**: Solves a real problem — agents interacting with UIs without brittle scraping
- **Framework-agnostic on agent side**: Any agent framework can interact with AN components
- **Developer-friendly**: Just React components with extra metadata
- **Dual-use**: Same UI for humans and agents

## Weaknesses

- **Very early stage**: Small library, limited component set
- **React-only**: No Vue, Svelte, etc.
- **Niche**: Only relevant if you're building UIs that agents interact with
- **Adoption-dependent**: Value increases with ecosystem adoption

## Relevance to autonomOS

### For our dashboard (HIGH)
The autonomOS dashboard could be built with AN SDK components, making it:
- **Agent-controllable**: Agents could interact with the dashboard programmatically
- **Self-describing**: The dashboard's capabilities are discoverable by agents
- **Meta**: A control plane that agents can also control

### As an integration target (LOW)
Not something autonomOS observes — it's a UI library.

### Key patterns to adopt
- **Component self-description** — our dashboard components should describe themselves for agent interaction
- **Dual human/agent interface** — design the dashboard API so both humans (browser) and agents (API) can use it
- **Structured interaction** — prefer structured APIs over screen scraping for agent-UI communication

## Integration Ideas

| Idea | Description | Value |
|------|-------------|-------|
| AN SDK dashboard | Build autonomOS dashboard with agent-native components | Agents can control the control plane |
| Component library | Publish autonomOS-specific AN components (agent status cards, tool logs, etc.) | Ecosystem contribution |
| MCP bridge | AN components expose capabilities via MCP | Agents discover dashboard actions as tools |
