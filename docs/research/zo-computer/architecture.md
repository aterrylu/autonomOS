# Zo Computer -- Architecture & Technical Deep Dive

## Infrastructure Model

Zo gives each user a **dedicated containerized Linux server** running 24/7 (on paid plans; free tier sleeps). The architecture leverages enterprise container orchestration:

```
                     Zo Platform
                    +---------------------------+
                    |  Container Orchestrator    |
                    |  (manages per-user VMs)    |
                    +---------------------------+
                         |           |
              +----------+           +-----------+
              |                                  |
    +---------v----------+         +-------------v-------+
    | User A's Server    |         | User B's Server     |
    | - Full Linux       |         | - Full Linux        |
    | - Root access      |         | - Root access       |
    | - 4-64 cores       |         | - Custom resources  |
    | - SSH on port 2222 |         | - Snapshots         |
    | - /home/workspace  |         | - /home/workspace   |
    +---------+----------+         +---------------------+
              |
    +---------v----------+
    | Services:          |
    | - AI chat server   |
    | - Web hosting      |
    | - SSH daemon       |
    | - Agent scheduler  |
    | - MCP endpoint     |
    +--------------------+
```

### Key Infrastructure Features

1. **Dynamic scaling**: Resources can be adjusted instantly (e.g., 7 CPUs to 64 CPUs), with serverless-like economics (~$0.07 for 10 min burst)
2. **Snapshot/restore**: Container-level snapshots enable "time travel" -- restore to any previous state if an AI agent causes damage
3. **Networking**: TCP, P2P, and BitTorrent support; custom domain routing; public URL generation for services
4. **Storage**: 100GB+ SSD per user at `/home/workspace`, with desktop sync via Electron app

## Tech Stack (Observable)

The core platform is closed-source, but we can infer the stack from public repos, docs, and API behavior:

| Layer | Technology | Evidence |
|-------|-----------|----------|
| **Marketing site** | Next.js (TypeScript) | `zo-web` repo: 97% TypeScript, Next.js config files |
| **CMS** | Basehub | `zocms` repo: "Basehub CLI + prompt" |
| **Skills registry** | TypeScript + Bun | `skills` repo: Bun for validation/sync, YAML config |
| **CLI tools** | TypeScript | `x` repo: "x cli" in TypeScript |
| **API** | REST + SSE | Documented at `api.zo.computer`, Bearer auth, structured JSON |
| **MCP endpoint** | HTTP transport | `api.zo.computer/mcp`, standard MCP protocol |
| **Desktop app** | Electron (likely) | File sync, cross-platform (Mac/Win/Linux) |
| **AI inference** | Multi-provider | Routes to OpenAI, Anthropic, Cerebras, Groq, Google via API |
| **Web parsing** | Python (Selectron) | `selectron` repo: "AI web parser library + CLI" (MIT, 48 stars) |
| **Server runtime** | Linux containers | SSH access, bash commands, sshd service |
| **Auth** | Bearer tokens | `zo_sk_*` prefix tokens, generated in Settings > Advanced |

### What We Cannot See

- Backend framework (likely Node.js or Go given team background)
- Database (likely PostgreSQL given Stripe/Substack DNA)
- Container orchestrator (likely Kubernetes or Firecracker)
- Message queue / event bus (if any)
- Monitoring/observability stack
- Deployment infrastructure

## Agent Architecture

Zo's agent system is a **scheduled task executor** with AI at its core:

```
User defines agent:
  - Instruction (natural language prompt)
  - Schedule (one-time or recurring cron)
  - Model selection (which LLM to use)
  - Notification preferences (SMS/email/Telegram)

Agent execution:
  1. Scheduler triggers at configured time
  2. Agent gets full context: user bio, rules, personas, files, integrations
  3. AI executes with access to 50+ tools
  4. Results stored as conversation
  5. Optional notification sent to user
```

### Agent API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/agents` | POST | Create agent with instruction, schedule, model |
| `/agents` | GET | List all agents |
| `/agents/:id` | PUT | Update agent config |
| `/agents/:id` | DELETE | Remove agent |
| `/agents/:id/run` | POST | Execute immediately (bypass schedule) |
| `/agents/:id/conversations` | GET | List execution history |

### Limitations vs autonomOS Needs

- **No orchestration**: Agents run independently, no agent-to-agent coordination
- **No workflow DAGs**: Only simple time-based triggers, no conditional flows
- **No observability**: Can view past conversations, but no real-time streaming of agent execution
- **No cost granularity**: Credits tracked at account level, not per-agent or per-model

## Skills System

The skills system is an **open, file-based capability registry**:

```
Skills/
  weather/
    SKILL.md          # Required: frontmatter + instructions
    scripts/          # Optional: executable code
    references/       # Optional: documentation
    assets/           # Optional: templates, data

SKILL.md format:
---
name: "Weather Lookup"
description: "Get current weather for any location"
metadata:
  author: "zocomputer"
allowed-tools:
  - web_search
  - read_webpage
---

## Instructions
When the user asks about weather...
```

### Progressive Loading Model

Skills use lazy loading for performance:
1. **Metadata loaded immediately** -- name, description, triggers
2. **Full instructions loaded on match** -- when task matches skill's purpose
3. **Scripts/assets loaded on demand** -- only when explicitly referenced in instructions

### Three Skill Tiers

1. **Official** -- Maintained by Zo team (core capabilities)
2. **External** -- Third-party skills synced from external repos via `external.yml`
3. **Community** -- User-contributed, validated with `bun validate`

### Relevance to autonomOS

The SKILL.md pattern is interesting as a **lightweight capability definition format**. It's simpler than MCP tool definitions but more structured than raw system prompts. autonomOS could use a similar pattern for agent configuration templates.

## MCP Server Integration

Zo exposes itself as an MCP server, making all 50+ tools available to any MCP-compatible client:

```
MCP Client (Claude Code, Cursor, Zed, etc.)
    |
    | HTTP transport + Bearer auth
    |
    v
https://api.zo.computer/mcp
    |
    | Routes to appropriate tool
    |
    v
+--------------------+
| Zo Tool Registry   |
| - File operations  |
| - Shell commands   |
| - Web browsing     |
| - Image generation |
| - Integrations     |
| - Agent management |
| - Service hosting  |
+--------------------+
```

### MCP Configuration Example

```json
{
  "mcpServers": {
    "zo": {
      "type": "streamable-http",
      "url": "https://api.zo.computer/mcp",
      "headers": {
        "Authorization": "Bearer zo_sk_your_key_here"
      }
    }
  }
}
```

For stdio-based clients, `mcp-remote` bridges the gap:
```json
{
  "mcpServers": {
    "zo": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://api.zo.computer/mcp",
               "--header", "Authorization:${AUTH_HEADER}"]
    }
  }
}
```

### MCP Tool Categories (50+)

| Category | Example Tools | Count |
|----------|--------------|-------|
| File operations | read_file, create_file, edit_file, list_files, grep_search | ~6 |
| Shell execution | run_bash_command, run_parallel_cmds, run_sequential_cmds | 3 |
| Web browsing | read_webpage, save_webpage, use_webpage, view_webpage, web_search | ~7 |
| AI/Generation | generate_image, edit_image, generate_video, transcribe_audio | ~5 |
| Integrations | use_app_gmail, use_app_notion, use_app_linear, etc. | ~9 |
| Agent management | create_agent, edit_agent, delete_agent, list_agents, run_agent | 5 |
| Site hosting | create_website, publish_site, manage routes/assets | ~8 |
| Communication | send_email, send_sms, send_telegram_message | 3 |
| Stripe/Commerce | create_product, create_price, create_payment_link | ~6 |
| Configuration | update_settings, manage personas, manage rules | ~6 |

## API Surface

Well-documented REST API at `api.zo.computer`:

| Domain | Endpoints | Purpose |
|--------|-----------|---------|
| AI | 10 | Chat, streaming, model selection, capabilities |
| Agents | 6 | CRUD + run + conversation history |
| Conversations | 6 | CRUD + file search + duplication |
| Browser | 4 | Session management, auth, context |
| Custom Domains | 6 | Domain CRUD + verification |
| Devices | 5 | Device registration + heartbeat |
| Personas | 10 | CRUD + activation per channel |
| Rules | 4 | CRUD for behavior rules |
| Space (Sites) | 5 | Route management + assets |
| User Services | 4 | Service CRUD (hosting) |

**Authentication:** Bearer token (`zo_sk_*` prefix)
**Streaming:** SSE via `stream: true` parameter on `/zo/ask`
**Structured output:** JSON schema via `output_format` parameter
**OpenAPI spec:** Available at `docs.zocomputer.com/openapi.json`

## Claude Code on Zo

Zo can run Claude Code directly on its server:
1. User SSHs into Zo or uses terminal in web UI
2. Runs `claude` command (Claude Code CLI)
3. Authenticates with Anthropic account
4. Claude Code runs with full access to Zo's filesystem and tools

This means Claude Code agents on Zo have access to:
- Persistent file storage across sessions
- Always-on server (no laptop required)
- All of Zo's integrations
- Web hosting for deploying what they build

## Substrate Heritage

The Substrate inference platform (2023-2024) had sophisticated architecture:

1. **DAG analysis**: Workloads analyzed as directed acyclic graphs, nodes merged for batching
2. **Intelligent scheduling**: Automatic parallelization without manual async code
3. **Data locality**: Entire workloads ran in same cluster, minimizing network roundtrips
4. **Concurrency management**: Server-side scheduling instead of client-side retry loops

It's unclear how much of this carries over to Zo. The inference routing (multi-model selection) likely uses similar optimization, but the consumer UX layer is entirely new.
