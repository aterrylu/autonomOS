## ADR-026: Native Cron Scheduler with Croner
**Date:** 2026-04-14
**Decided by:** Terry + CronDesign agent (research + design session)
**Source:** Claude Code session (cron scheduler feature implementation)

**Context:** autonomOS needs a scheduling system so agents can create recurring and one-time tasks. Claude Code has three scheduling tiers (session-scoped CronCreate, desktop SKILL.md, cloud Triggers) but none integrate with multi-agent orchestration. Competitors (Devin, Zo, Cursor) have limited scheduling. The scheduler needs to integrate with the existing gateway, templates, and MCP tool systems.

**Decision:** Server-side cron scheduler using Croner v10 (timer-based, not polling). Each enabled schedule gets its own `Cron` instance. Schedules stored as JSON files in `~/.autonomos/schedules/`, run history as append-only JSONL. Two execution modes: `isolated` (headless `claude -p` child process) and `agent:<name>` (inject prompt via gateway). Six MCP tools for CRUD + trigger. Dashboard pane for monitoring — no create button (agents create schedules, dashboard controls them). Overlap policies (skip/allow), global concurrency limits, startup catch-up for missed runs.

**Rationale:** Croner is zero-dep, TypeScript-first, used by OpenClaw. Timer-based scheduling (no polling) is more efficient. File-based storage follows the templates pattern. The "agents create, dashboard controls" pattern matches autonomOS's philosophy. Overlap policies (inspired by Temporal) prevent runaway agent scheduling. Gateway integration for `onComplete` delivery is a unique differentiator vs. competitors.

**Alternatives:**
- **Polling-based scheduler** — less efficient, harder to handle timezones correctly.
- **Database-backed storage** — overkill for local-first tool, files are simpler and human-readable.
- **node-cron** — less maintained, no timezone support, no previous-run computation.
- **Dashboard-based schedule creation** — goes against autonomOS philosophy where agents are the creators.
