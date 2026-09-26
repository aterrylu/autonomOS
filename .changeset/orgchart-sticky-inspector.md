---
"@autonomos/dashboard": patch
"@autonomos/server": patch
"@autonomos/core": patch
---

fix(orgchart): the inspector stays open, same-named agents are told apart, and the statusline agrees with the chart

The Org Chart's detail panel no longer closes when you click empty space on
the chart. Click another card to switch to it; close it with its ×, Esc, or by
switching to another pane.

Agents can share a name. When two cards on the chart do, each now shows a short
id after the name (for example "Twin #a1b2"), so they read as two agents.

The statusline's manager and "↓N reports" now come from the same definition
the Org Chart uses, so the two can't disagree. The statusline's data also says
whether the manager is still running, so a future statusline can mark a dead
manager.
