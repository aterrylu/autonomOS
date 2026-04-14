# Cron Scheduler Research

Research into scheduling and automation systems for AI coding agents. Investigating how Claude Code, Devin, Zo Computer, Cursor, and workflow orchestration platforms (Temporal, n8n, Inngest) handle recurring task execution, with a focus on UI/UX patterns, data models, and agent programmability.

**Date:** 2026-04-11
**Status:** Active research, pre-implementation
**Relevance:** HIGH — directly informs the autonomOS cron scheduler feature

## Research Files

- **[claude-code-scheduling.md](claude-code-scheduling.md)** — Deep dive into Claude Code's three-tier scheduling model: session-scoped (CronCreate), desktop-persistent (SKILL.md), cloud-persistent (Scheduled Tasks). Covers implementation details, data models, UX, agent programmability, and gaps.
- **[competitor-landscape.md](competitor-landscape.md)** — Survey of scheduling/automation UIs across Devin, Zo Computer, Cursor, GitHub Actions, Temporal, n8n, Inngest, and Windsurf. Includes links to documentation, product pages, and demos. Identifies patterns to adopt and gaps to exploit.

## Key Findings Summary

### Claude Code's Three-Tier Model

| Tier | Mechanism | Persistence | Min Interval | Key Trait |
|------|-----------|-------------|-------------|-----------|
| 1 | CronCreate (tools) | In-memory, session-scoped | 1 min | 7-day expiry, 50 task limit, deterministic jitter |
| 2 | Desktop Scheduled Tasks | Disk (SKILL.md) | 1 min | Per-task permission modes, missed-run catch-up |
| 3 | Cloud Scheduled Tasks | Anthropic VMs | 1 hour | Fresh repo clone per run, MCP connectors |

### Competitor Standouts

- **Devin** — Gold standard for AI agent scheduling. Recurring/one-time split, visual + custom cron editor, playbook attachment, notification options (always/failure/never), Slack integration, "Run as" user concept. Docs: https://docs.devin.ai/product-guides/scheduled-sessions
- **Zo Computer** — Conversational automation creation. Dedicated "Automations" sidebar tab. Conditional notifications. Docs: https://docs.zocomputer.com/automations
- **Temporal** — Overlap policies (SKIP/QUEUE/ALLOW_ALL/CANCEL_PREVIOUS). Critical concept for agent scheduling. Docs: https://docs.temporal.io/develop/typescript/workflows/schedules
- **Cursor** — No scheduling, but excellent agent dashboard UX with state-based grouping. Blog: https://cursor.com/blog/cursor-3

### Gaps Nobody Fills (autonomOS Opportunities)

1. **Agent-aware scheduling** — Nobody connects scheduling to multi-agent orchestration. We can schedule agent teams, not just single sessions.
2. **Gateway-integrated completion** — `send()` on completion to other agents or platform channels. Nobody has this.
3. **Three execution modes in one UI** — isolated (`claude -p`), inject-into-existing (`send()` to running agent), full session (`createSession()`). Nobody offers all three.
4. **Hook telemetry in run history** — Tool usage, token consumption, error rates per scheduled run. We already collect this data.
5. **Hierarchy-aware scheduling** — Org chart integration. Scheduled triggers that spawn team leads who spawn workers.

## Links

### Claude Code
- Desktop scheduled tasks: `~/.claude/scheduled-tasks/<name>/SKILL.md`
- Cloud scheduled tasks: `claude.ai/code/scheduled`
- `/schedule` CLI skill for cloud task management
- CronCreate/CronDelete/CronList tools (session-scoped)

### Competitors
- Devin Scheduled Sessions: https://docs.devin.ai/product-guides/scheduled-sessions
- Devin Playbooks: https://docs.devin.ai/product-guides/creating-playbooks
- Zo Computer Automations: https://docs.zocomputer.com/automations
- Cursor 3 (agents, no scheduling): https://cursor.com/blog/cursor-3
- Cursor Self-Driving Codebases: https://cursor.com/blog/self-driving-codebases
- Temporal Schedules: https://docs.temporal.io/develop/typescript/workflows/schedules
- n8n Schedule Trigger: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger/
- Inngest Crons: https://www.inngest.com/docs/guides/scheduled-functions
- GitHub Actions Schedule: https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule

## Assessment

**Relevance to autonomOS: HIGH.** The scheduling landscape is fragmented — Claude Code has three separate mechanisms with no unified view, Devin has the best single-product implementation but no multi-agent awareness, and nobody integrates scheduling with agent messaging. autonomOS is uniquely positioned to build the first scheduling system that's agent-hierarchy-aware, gateway-integrated, and offers all three execution modes (isolated, inject, session) in a single UI.

**Next steps:** Design the data model, decide on overlap policies, build the server-side scheduler and REST API, then the dashboard UI.
