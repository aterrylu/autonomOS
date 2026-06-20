---
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Add a "queue send on usage-clear" overlay button to each terminal pane. When you hit the Claude usage limit, type your next prompt into Claude Code's input box and click the bottom-right hourglass to arm the pane — the server watches usage and presses Enter the moment the limit next clears, even with no dashboard open. Detection is poll-based (it fires on the observed utilization drop, not a scheduled `resetsAt`), so an early or unexpected clear still triggers it. Arming while capped fires on the next clear; arming before you're capped waits and fires when a block lifts; a pane that was never blocked never auto-fires. Multiple armed panes fire together on the shared account-wide clear. Click again to cancel; state is in-memory and bounded by the PTY's lifetime.
