---
"@autonomos/dashboard": minor
"@autonomos/server": minor
---

feat: right-click Rename agent (restart-under-new-name)

Adds a **Rename…** item to the agent-row context menu (running rows), closing the ADR-093 deferral. Motivated by agents resumed from the Projects tab that "never had a name to begin with" (ADR-096).

- **Restart-under-new-name.** Rename mutates the record `name` (`PATCH /api/agents/:id`, re-added on the body-`version` convention), then restarts (kill → attach) so the resumed session boots with the new `--name`, and returns the pane focused (reusing the #353 re-open-after-attach fix). No PTY injection.
- **Inline, warned, safe.** The menu body swaps for a name input pre-filled with the current name + the warning "Renaming restarts this session — the conversation resumes." A namesake collision (another running agent holds the name) is a 409 **before** anything is torn down; an empty/whitespace name is rejected; an unchanged name is a no-op (never a bare restart); a failed rename shows the reason inline and keeps the form open (mirrors the Delete confirm). Escape peels rename mode first (LIFO), then the menu.
- **customTitle caveat (documented, ADR-096):** the new name is authoritative for the sidebar/record and for the motivating no-name case; a session `/rename`-d inside Claude keeps that in-session title on the Projects tab + name-lookups until re-`/rename`d.

Tests: server route (rename/trim/empty-400/namesake-409/stale-409/404), store (patch-before-restart order + rethrow-before-teardown), and context-menu dom (item present running-only, pre-filled input + warning, submit/cancel/unchanged/error).
