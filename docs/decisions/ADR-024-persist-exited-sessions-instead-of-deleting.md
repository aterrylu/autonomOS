## ADR-024: Persist Exited Sessions Instead of Deleting
**Date:** 2026-04-07
**Decided by:** Terry + TeamLead agent
**Source:** Claude Code session (autonomOS team lead discussion)

**Context:** When an agent exits (PTY process ends naturally or via kill), `onExit` calls `removePersistedSession()` which deletes the entry from `sessions.json`. This means exited agents vanish completely — their org chart position, template, manager, and name are all lost. Terry wants the ability to bring back exited agents without re-configuring everything.

**Decision:** Instead of deleting sessions from `sessions.json` on exit, mark them with `status: "exited"`. The dashboard shows exited sessions in a grayed-out/collapsed state. Users can manually resume them via a `POST /api/sessions/:id/resume` endpoint. Only an explicit permanent delete action truly removes the entry. `resumePersistedSessions()` on boot skips exited entries (don't auto-resume).

**Rationale:** Preserves all session metadata (template, manager, project, name) across exits. Makes agents feel persistent rather than ephemeral. Also naturally fixes a pre-existing race condition (see ADR-025).

**Alternatives:**
- **Separate "archive" storage** — unnecessary complexity, same data structure works with a status field.
- **Prompt before deleting** — disruptive UX, doesn't help with programmatic kills.
- **Auto-resume all on boot** — unwanted. Some agents exit intentionally.
