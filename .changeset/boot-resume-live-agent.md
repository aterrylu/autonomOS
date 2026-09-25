---
"@autonomos/server": patch
---

fix(runtime): the boot resume sweep never crashes a live agent

From the moment the control socket binds, the server accepts new agents, but the boot sweep that brings back agents from before a restart used to list the store only after several awaited imports. An agent created in that window (by the dashboard, another agent, or a test) was picked up as if it predated the restart; the resume failed with "already attached", and the sweep's error handler marked the live agent crashed and revoked its token, so its status froze and every hook it sent was rejected while the dashboard showed it crashed. This was the intermittent `agent-spawn-prompt` CI failure; #382's new import widened the window.

- The sweep's list is now snapshotted synchronously right after the socket binds, before the first await, so later awaits can't reopen the window.
- The sweep re-reads each record and skips an agent that is already live, logging once; it keeps its PTY, token and status.
- Every respawn error path (boot sweep, the crash-net fresh respawn, restart-all) now goes through one guard that never marks a live agent crashed, and the boot sweep only sends "Failed to resume" when the agent really stayed down.
