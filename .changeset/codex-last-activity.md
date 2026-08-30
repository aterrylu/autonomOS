---
"@autonomos/server": patch
---

fix(codex): advance lastActivityAt from the status feed so codex recency isn't frozen at spawn

Codex has no hook relay, so its `lastActivityAt` never advanced after spawn — the dashboard showed each codex session's **birth** date, not its last-active time (unlike Claude Code, whose hook events feed it). Terry's "the date next to each codex session is the date it was born, not the last time it was active" bug.

The gateway's status-watch client is a non-creator of the thread and structurally can't see `turn/`/`item/` events, so activity is derived from the busy/idle status feed: **"working"** (including the periodic `thread/read` status poll — our only mid-turn signal) advances `lastActivityAt`, and the **working→idle** transition forces the turn-boundary flush. Compacting is excluded (housekeeping, mirroring CC's Pre/PostCompact exclusion). It feeds TerminalRender's `markActivity` (#351) via an injected sink (keeping codexControl free of its import-cycle-forbidden autonomOS imports), emitting a recency delta when the value persists.

Caveat (ADR-060): a codex agent parked in `collaboration.wait_agent` reads as *active*, so it shows perpetually-fresh activity while wait-idling — inside a live turn, but not identical to Claude Code, where a waiting agent ages via Stop→idle.
