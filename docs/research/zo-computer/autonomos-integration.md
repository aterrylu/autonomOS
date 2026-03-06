# Zo Computer -- autonomOS Integration Analysis

## 1. Relationship Between Zo and autonomOS

Zo and autonomOS operate at **different layers of the agent stack**:

```
+-------------------------------+
| autonomOS (Mission Control)   |  <-- Observability + orchestration
| - Session monitoring          |
| - Multi-agent orchestration   |
| - Cost analytics              |
| - Task management             |
+-------------------------------+
           |  observes / controls
           v
+-------------------------------+
| Agent Runtimes                |  <-- Where agents execute
| - Claude Code (local/Zo)     |
| - Codex                      |
| - OpenClaw                   |
+-------------------------------+
           |  runs on
           v
+-------------------------------+
| Infrastructure                |  <-- Compute + storage
| - Local machine              |
| - Zo Computer (cloud)        |
| - Other cloud providers      |
+-------------------------------+
```

Zo is infrastructure + runtime; autonomOS is the control plane. They are complementary, not competitive.

## 2. What to Adopt (Pattern-for-Pattern)

### A. SKILL.md Format (MEDIUM PRIORITY)

The skills registry's `SKILL.md` format is a clean, portable way to define agent capabilities:

```yaml
---
name: "Skill Name"
description: "What this skill does"
metadata:
  author: "author-name"
allowed-tools:
  - tool_a
  - tool_b
---
## Instructions
Natural language instructions for the agent...
```

**For autonomOS:** Consider a similar format for agent configuration templates. Instead of complex JSON/YAML configs, a markdown-based format with frontmatter metadata + natural language instructions is:
- Human-readable and version-controllable
- Compatible with Obsidian/wiki workflows
- Easy for non-developers to author

### B. Progressive Loading Model (LOW PRIORITY)

Skills use lazy loading: metadata first, full instructions on match, scripts on demand. This is a sensible pattern if autonomOS ever builds a skill/plugin marketplace.

### C. MCP Tool Organization (MEDIUM PRIORITY)

Zo's 50+ tools are well-organized into categories. When autonomOS exposes its own MCP server (for other tools to interact with autonomOS), use a similar categorical structure.

## 3. What to Adapt (Different Implementation, Same Concept)

### A. Agent Scheduling (MEDIUM PRIORITY)

**Zo's approach:** Simple cron-like scheduling per agent. Each agent runs independently.

**autonomOS approach:** Workflow-based scheduling where:
- Agents can trigger other agents
- Conditional execution based on results
- Cost budgets limit execution
- Tasks map to agent sessions

### B. Persona/Rules System (LOW PRIORITY)

**Zo's approach:** Personas (system prompts) and rules (behavior modifiers) that customize AI responses per channel (chat, SMS, email).

**autonomOS approach:** Similar concept but scoped to agent orchestration -- agent templates/profiles that define default behavior, tool access, and cost limits for different types of work.

### C. API Design (MEDIUM PRIORITY)

**Zo's approach:** Clean REST API with Bearer auth, SSE streaming, structured output via JSON schema.

**autonomOS approach:** Similar API structure but focused on session management rather than chat:
- `GET /sessions` -- list all observed sessions
- `GET /sessions/:id/stream` -- SSE stream of session events
- `POST /sessions` -- spawn new agent session
- `POST /sessions/:id/message` -- send message to session
- `GET /analytics/costs` -- cross-session cost analytics

## 4. What to Build New (Not in Zo)

| Feature | Why Zo Doesn't Have It | Priority for autonomOS |
|---------|----------------------|----------------------|
| Session discovery | Zo IS the platform; no external sessions to discover | HIGH |
| Cross-session analytics | Zo tracks credits at account level only | HIGH |
| Multi-agent orchestration | Zo agents are independent | HIGH |
| Per-model cost tracking | Zo abstracts away model costs into credits | HIGH |
| Real-time session streaming | Zo shows conversations after completion | MEDIUM |
| Task-to-session mapping | Zo has no task/project management | MEDIUM |
| Agent coordination | Zo agents can't communicate with each other | MEDIUM |
| Provider metrics | Zo hides provider details behind credit system | MEDIUM |

## 5. Integration Strategy

### Phase 1: Zo as MCP Provider (LOW EFFORT, HIGH VALUE)

autonomOS connects to a user's Zo server via MCP to gain access to Zo's tools:

```
autonomOS Dashboard
    |
    | MCP client connection
    |
    v
Zo MCP Server (api.zo.computer/mcp)
    |
    +-- File operations on Zo
    +-- Web browsing via Zo
    +-- Integration access (Gmail, Notion, etc.)
    +-- Agent creation/management on Zo
```

**Implementation:** Add Zo as an MCP server in autonomOS's config. Treat it as another tool provider alongside local tools. This gives autonomOS agents access to Zo's capabilities without any custom integration code.

**Risk:** Low. Standard MCP protocol, well-documented API.

### Phase 2: Zo Agent Monitoring (MEDIUM EFFORT, MEDIUM VALUE)

Monitor agents running on Zo through its API:

```typescript
// Poll Zo API for agent status
const agents = await fetch('https://api.zo.computer/agents', {
  headers: { Authorization: `Bearer ${token}` }
}).then(r => r.json());

// Poll each agent's conversations for execution history
for (const agent of agents) {
  const conversations = await fetch(
    `https://api.zo.computer/agents/${agent.id}/conversations`,
    { headers: { Authorization: `Bearer ${token}` } }
  ).then(r => r.json());
  // Index in autonomOS dashboard
}
```

**Limitation:** Zo's API is polling-based for agent status. No WebSocket/SSE for real-time agent execution monitoring. This limits observability to after-the-fact conversation review.

### Phase 3: Claude Code on Zo Observation (ASPIRATIONAL)

If Claude Code runs on a Zo server, autonomOS could potentially observe it by:
1. SSH into Zo server
2. Scan `~/.claude/projects/` for session JSONL files
3. Use the same FileWatcher pattern from YepAnywhere research

**Risk:** High complexity. Requires SSH access to user's Zo, permission management, and reliable file watching over SSH.

## 6. What NOT to Integrate

| Capability | Why Skip |
|-----------|---------|
| Zo hosting/sites | autonomOS is not a hosting platform |
| Zo file storage | autonomOS doesn't need cloud storage |
| Zo desktop sync | Different use case entirely |
| Zo SMS/email interface | autonomOS is dashboard-first |
| Zo billing/Stripe | Different business model |
| Zo personas | autonomOS needs agent profiles, not chat personas |

## 7. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Vendor lock-in (closed-source) | MEDIUM | Use standard MCP protocol; Zo is one provider among many, not a dependency |
| API stability | LOW | Zo has versioned releases, OpenAPI spec; typical API contract |
| Pricing changes | MEDIUM | Zo's free tier is limited; paid tiers needed for always-on agents; budget accordingly |
| Feature overlap confusion | LOW | Clear layer separation: Zo = infrastructure, autonomOS = control plane |
| MCP protocol evolution | LOW | MCP is Anthropic-backed standard; both Zo and autonomOS will track it |

## 8. Key Takeaway

Zo Computer is **not a competitor to autonomOS** -- it's a potential **infrastructure provider**. The most practical integration is using Zo as an MCP server to give autonomOS agents access to cloud compute, integrations, and hosting without self-hosting. The skills registry pattern is worth studying for agent configuration design.

However, Zo's closed-source nature limits its value as a reference implementation. We cannot study its internals the way we can with YepAnywhere (MIT) or Mission Control (MIT). For architectural patterns, CC-Insights and YepAnywhere remain the primary references.

**Concrete next steps:**
1. Test connecting to Zo's MCP endpoint from a local Claude Code instance to validate the integration path
2. Evaluate whether the SKILL.md format could replace or complement autonomOS's agent configuration approach
3. Monitor Zo's API for real-time agent streaming capabilities (currently absent but likely coming)
