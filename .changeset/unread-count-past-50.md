---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

An agent's unread count no longer stops at 50. Each agent still keeps only its latest 50 notifications, but the count now includes the older unread ones too, so a busy agent's badge and the bell show the real number. The bell panel says how many older unread it can't list, and "Mark all read" now clears agents whose unread are all older than the panel's page.
