---
"@autonomos/dashboard": minor
---

feat(dashboard): right-click context menu on agent rows

Right-clicking an agent row now opens a context menu (ADR-093). Running rows (sidebar tree) get **Open · Kill · Restart · Set manager · Delete**; exited records (Projects panel) get **Resume · Set manager · Delete**. Items are grouped process / record / danger with a danger-zone tint, and Delete is guarded by an in-place inline confirm that shows the server's reason on failure instead of closing as if it worked.

The trigger is row-scoped (never a document-level handler, so xterm keeps right-click inside terminal panes); dismissal rides the ADR-065 escape stack with click-away and keyboard navigation. Adds `restartSession`/`setManager` store actions and an `agentsApi.manager` client method (the server route already existed). Archive and rename were considered and deferred — see ADR-093.
