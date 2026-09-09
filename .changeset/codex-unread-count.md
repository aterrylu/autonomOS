---
"@autonomos/server": patch
---

fix(codex): count completed Codex turns in the unread (#num) badge

Codex emits no hook events (its status comes from the app-server event stream),
so its completed turns never fired the `Stop` hook that increments the agent-row
unread count for Claude Code and Gemini — the badge stayed frozen at 0.

The fix routes the Codex working→idle turn boundary (its `Stop` analog — the
same edge that flushes `lastActivityAt`, #352) through the SAME
notification/unread path: a new `noteAgentTurnComplete` appends a turn-complete
notification, so `getUnreadCount` increments and `markRead` (on pane-view)
clears it. No parallel counter; Codex already rode the shared status-delta path,
only the notification append was missing. Best-effort like the activity flush:
one per working→idle turn boundary, with possible under-counts (a turn ending
through a compaction, or a missed idle edge). A repeated `idle` can't re-fire
(the sink dedups on its prev-status), so a stable turn counts exactly once.
