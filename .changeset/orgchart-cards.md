---
"@autonomos/core": patch
"@autonomos/dashboard": patch
"@autonomos/server": patch
---

feat(orgchart): cards sit closer together and show more — stacked reports and the Balanced card

A lead's reports now stack in a column under it, like the sidebar, so the chart
gets much narrower: a fleet of about 17 agents now fits on screen at 100%
instead of opening zoomed out with the map.

Each card now shows more at a glance: its CLI's own icon as the avatar, an unread count, a pulsing dot while it works or waits on
you, what it's doing right now (the file it's editing, like "Edit store.ts", or
the program it's running, like "Running npm", never the command's arguments), how long it's been in that state, and a thin
strip along the bottom with the last 24 hours of activity. The whole fleet's
history comes from one request.

Codex agents show "Working" rather than a guessed tool, and nothing shows a
number the agent can't actually report.
