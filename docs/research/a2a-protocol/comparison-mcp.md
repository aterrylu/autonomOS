# A2A vs MCP — Comparison

## The One-Sentence Summary

**MCP** connects an agent to tools and data (vertical integration — agent to world).
**A2A** connects agents to each other (horizontal integration — agent to agent).

They are complementary layers in a multi-agent stack, not competitors.

---

## Side-by-Side Comparison

| Dimension | MCP (Model Context Protocol) | A2A (Agent2Agent Protocol) |
|---|---|---|
| **Creator** | Anthropic | Google (now Linux Foundation) |
| **Announced** | November 2024 | April 2025 |
| **Purpose** | Agent ↔ Tools/Data/Resources | Agent ↔ Agent |
| **Integration axis** | Vertical (agent to world) | Horizontal (agent to agent) |
| **Primary use case** | Extending a single agent's capabilities | Multi-agent collaboration and delegation |
| **Who initiates** | Agent (client) calls tool server | Either agent can be client or server |
| **What's exposed** | Tools (functions), Resources (data), Prompts | Tasks, Skills, Artifacts |
| **Communication** | JSON-RPC, client-server | JSON-RPC 2.0, HTTP/SSE/gRPC |
| **State management** | Stateless tool calls | Rich task state machine (8 states) |
| **Long-running ops** | Not natively — tools return immediately | Native support (working → completed with streaming/push) |
| **Discovery** | Server URL + tool listing | Agent Card at `/.well-known/agent.json` |
| **Auth** | Per-server config | OAuth 2.0, API keys declared in Agent Card |
| **Agent opacity** | Agent sees tool implementation | Agents are "opaque" — no internal visibility |
| **Human-in-loop** | Not specified | `input-required` task state handles this |

---

## How They Layer Together

```
┌─────────────────────────────────────────────────────┐
│                   User / Orchestrator                │
└─────────────────────────┬───────────────────────────┘
                          │
                    A2A Protocol
                (agent ↔ agent layer)
                          │
         ┌────────────────┼────────────────┐
         │                │                │
   ┌─────▼─────┐   ┌──────▼──────┐  ┌─────▼──────┐
   │  Agent A  │   │   Agent B   │  │  Agent C   │
   └─────┬─────┘   └──────┬──────┘  └─────┬──────┘
         │                │                │
     MCP Protocol     MCP Protocol     MCP Protocol
   (agent ↔ tools)  (agent ↔ tools)  (agent ↔ tools)
         │                │                │
   ┌─────▼─────┐   ┌──────▼──────┐  ┌─────▼──────┐
   │  DB Tool  │   │ Search Tool │  │  OCR Tool  │
   └───────────┘   └─────────────┘  └────────────┘
```

A real example: An "Invoice Processing Agent" exposes itself via A2A (receives tasks from orchestrators). Internally, it uses MCP to call an OCR tool to read invoice images, a database tool to look up vendor records, and an email tool to send confirmations. A2A handles the outer interface; MCP handles the inner tooling.

---

## When to Use Each

**Use MCP when:**
- You need to give an agent access to external tools, APIs, or data sources
- You're extending a single agent's capabilities
- The integration is tool-calling (deterministic, returns immediately)
- You're building MCP servers for databases, file systems, APIs

**Use A2A when:**
- You need agents to delegate work to other agents
- You have long-running tasks that need status tracking
- You're building multi-agent pipelines or orchestrators
- You need agents from different frameworks (LangChain, CrewAI, Claude, etc.) to interoperate
- You need human-in-the-loop approval states

**Use both when:**
- Building a sophisticated multi-agent system
- Each agent uses MCP for its own tooling needs AND A2A to coordinate with other agents

---

## The "Opaque Agent" Design

A key A2A design principle: **agents are opaque to each other**. The A2A server (remote agent) does not expose its internal implementation, memory, tools, or reasoning to the A2A client. The client only sees:
- What the Agent Card advertises (skills and capabilities)
- Task status updates
- Final artifacts

This is intentional — it allows agents to be built on different frameworks, with different models, using different internal architectures, and still interoperate.

This contrasts with MCP where the tool server is transparent about its exact function signatures and parameters.

---

## The Broader Protocol Landscape (2025)

There were briefly multiple competing agent communication protocols:
- **MCP** (Anthropic) — tool access layer
- **A2A** (Google) — agent collaboration layer
- **ACP** (IBM) — Agent Communication Protocol, focused on similar problems to A2A
- **ANP** — Agent Network Protocol, more decentralized/marketplace-oriented

The consolidation: IBM's ACP merged into A2A by August 2025. A2A now covers the agent-to-agent space. MCP covers the tool/resource space. ANP remains an alternative for decentralized agent marketplaces but has not achieved the same traction.

A survey paper (arxiv 2505.02279) proposes a phased adoption ladder:
1. MCP for tool access
2. A2A for agent collaboration
3. ANP for decentralized agent marketplaces
