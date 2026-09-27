---
"@autonomos/server": patch
---

A server restart no longer leaves a "1 unread" badge on agents that never had a turn. Resuming such an agent starts a fresh session (it never had a saved one), and that used to post a "no saved session to resume" warning every time, although nothing was lost. The warning still appears when an agent that actually conversed can't be resumed.
