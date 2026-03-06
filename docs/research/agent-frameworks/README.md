# Agent Frameworks & SDKs Research

Research into the agent framework/SDK landscape to understand:
1. How autonomOS can **integrate with** these frameworks (be the control plane for agents built with them)
2. How autonomOS can **use** these frameworks internally (for its own agent orchestration)
3. What patterns and abstractions are worth adopting

## Frameworks Covered

| Framework | Type | File |
|-----------|------|------|
| [LangGraph](langgraph.md) | Orchestration framework | Graph-based agent workflows |
| [Claude Agent SDK](claude-agent-sdk.md) | Minimal SDK | Thin agentic loop for Claude |
| [Claude Code](claude-code.md) | Product / CLI agent | Autonomous coding agent |
| [Gemini ADK](gemini-adk.md) | Orchestration framework | Google's agent development kit |
| [AN SDK (21st.dev)](an-sdk.md) | UI component SDK | Agent-native UI components |
| [n8n](n8n.md) | Automation platform | Visual workflow automation + AI agents |

## Quick Comparison

| | Type | Model Lock-in | Complexity | Multi-Agent | Primary Use Case |
|---|---|---|---|---|---|
| **LangGraph** | Framework | None | High | Yes (explicit graphs) | Complex orchestrated workflows |
| **Claude Agent SDK** | SDK | Claude only | Low | Basic (handoffs) | Simple Claude-powered agents |
| **Claude Code** | Product | Claude only | N/A (end-user tool) | No | Software engineering |
| **Gemini ADK** | Framework | Primarily Gemini | Medium | Yes (hierarchical) | Google ecosystem agents |
| **AN SDK** | UI Components | None | Low | N/A | Agent-interactable UIs |
| **n8n** | Automation Platform | None | Low (visual) | Via sub-workflows | Integration & automation glue |

## How They Stack Together

These operate at **different layers** of the agent stack:

```
+--------------------------------------------------+
|  UI Layer          AN SDK (agent-native UIs)      |
+--------------------------------------------------+
|  Control Plane     autonomOS (observe, configure) |
+--------------------------------------------------+
|  Agent Runtime     LangGraph / Claude Agent SDK   |
|                    / Gemini ADK                    |
+--------------------------------------------------+
|  Integration       n8n (connect to 400+ services) |
+--------------------------------------------------+
|  End-User Agents   Claude Code (coding agent)     |
+--------------------------------------------------+
```

autonomOS sits at the **control plane layer** — it doesn't compete with these frameworks, it **observes and orchestrates agents built with them**.

## Key Takeaways for autonomOS

1. **Integration surface**: Each framework has different hooks for observability. LangGraph has callbacks, Claude Agent SDK has hooks, Gemini ADK has session events. autonomOS needs adapters for each.
2. **Common abstractions**: All frameworks share concepts (agent, tool, session, message, step). Our `packages/core` types should map cleanly to all of them.
3. **n8n as glue**: n8n could serve as an integration layer for autonomOS — connecting agent events to Slack, databases, dashboards without custom code.
4. **AN SDK for our dashboard**: Agent-native UI components could make the autonomOS dashboard itself agent-controllable.
