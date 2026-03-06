# n8n

**By:** n8n GmbH
**License:** Sustainable Use License (source-available, free for <$40k revenue; otherwise paid)
**Language:** TypeScript
**Repo:** https://github.com/n8n-io/n8n
**Docs:** https://docs.n8n.io/

## What It Is

An open-source workflow automation platform with a visual node-based editor. Originally built for deterministic automations (if X then Y), now includes AI agent capabilities. Think Zapier but self-hostable and extensible.

## Core Concepts

- **Workflow**: A directed graph of nodes connected by edges, triggered by events or schedules
- **Nodes**: Pre-built integrations (400+) or custom code. Categories: triggers, actions, logic, AI
- **Credentials**: Centralized secret management for API keys, OAuth tokens, etc.
- **AI Agent Node**: LLM-powered node that can use tools in a loop (uses LangChain under the hood)
- **Sub-workflows**: Workflows that call other workflows (enables composition)
- **Webhooks**: HTTP endpoints that trigger workflows

## Architecture Pattern

```
Trigger (webhook, schedule, event)
    |
    v
[Node 1: Fetch data] --> [Node 2: AI Agent] --> [Node 3: Send Slack]
                              |       ^
                              v       |
                         [Tool Node]--+
```

Workflows are visual DAGs. The AI Agent node embeds an agentic loop within the larger workflow.

## Strengths

- **400+ integrations**: Slack, GitHub, Google Sheets, databases, APIs, email, etc.
- **Visual editor**: Non-developers can build and maintain workflows
- **Self-hostable**: Full control over data and infrastructure
- **Credential management**: Centralized, encrypted storage for all API keys
- **Webhook support**: Easy to create HTTP endpoints that trigger workflows
- **Active community**: Large marketplace of community-built nodes
- **AI capabilities**: AI agent node, vector store nodes, embedding nodes

## Weaknesses

- **AI is bolted-on**: Agent capabilities feel added to an automation tool, not core DNA
- **Limited agent control**: Can't customize the agent reasoning loop deeply
- **Visual editor limitations**: Complex workflows become hard to manage visually
- **Execution overhead**: Node-by-node execution adds latency vs direct code
- **License nuance**: Not truly open-source (Sustainable Use License restricts commercial use above $40k)
- **Single-tenant**: Each n8n instance is standalone; no built-in multi-agent coordination

## Relevance to autonomOS

### As an integration layer (HIGH)
n8n is the **glue** that connects agents to the rest of the world. autonomOS could:
- **Trigger n8n workflows** when agent events occur (e.g., agent completes task → Slack notification)
- **Use n8n as an action backend**: Instead of building 400 integrations, route actions through n8n
- **Webhook bridge**: n8n webhooks receive agent events, fan out to multiple destinations

### As an agent platform to observe (MEDIUM)
Users may run AI agents inside n8n. autonomOS should be able to:
- Monitor n8n workflow executions via the n8n API
- Track AI agent node token usage and performance
- Provide a unified view alongside other agent frameworks

### As an internal tool (LOW)
Could use n8n for autonomOS's own operational workflows (alerts, notifications, data sync) but probably overkill for early stages.

### Key patterns to adopt
- **Credential management** — autonomOS needs centralized secret management for agent API keys
- **Webhook triggers** — our event system should support webhook-based integrations
- **Visual workflow builder** — future feature: let users visually compose agent workflows in autonomOS

## Integration Points

| Integration | Description | Effort |
|-------------|-------------|--------|
| n8n API | REST API for workflow CRUD, execution history, credentials | Low |
| Webhooks (inbound) | autonomOS posts events to n8n webhook triggers | Low |
| Webhooks (outbound) | n8n calls autonomOS API as part of workflows | Low |
| Custom n8n node | Build an "autonomOS" node for n8n marketplace | Medium |
| Execution monitoring | Poll n8n API for workflow/execution data | Medium |

## n8n API Surface

Key endpoints for integration:
- `GET /workflows` — list all workflows
- `POST /workflows/{id}/run` — trigger a workflow
- `GET /executions` — list execution history
- `GET /executions/{id}` — get execution details (including step-by-step data)
- `POST /webhooks/{path}` — trigger webhook-based workflows
