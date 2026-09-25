---
"@autonomos/dashboard": patch
---

perf(dashboard): an agent's status change no longer re-renders the whole sidebar

Every agent status update (about 2 per tool call per agent) re-rendered ~185
sidebar components: every row's icons for every agent, plus every row of the
Projects list, even though only one agent had changed. It's now ~46 per update
(−75%) with 15 agents and ~60 projects:

- Collapsed projects no longer re-render on status updates. Only an open
  project's session rows show a live status.
- Agent icons (provider mark, status badge, tree guides) re-render only for
  the agent whose status changed.
- A status update keeps every unchanged agent's status entry, and the unread
  counts, as the same objects, so nothing downstream sees a false change.

Nothing looks different: the icons, badges and labels update exactly as before.
