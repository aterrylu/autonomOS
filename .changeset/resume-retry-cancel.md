---
"@autonomos/server": patch
---

fix(server): restarting an agent while autonomOS is waiting to retry its resume now starts a clean attempt

If a resumed agent closes right away, autonomOS waits a moment and tries the same conversation again. If you restarted the agent during that wait and it closed quickly again, the old retry could still fire on top of your restart, and your restart got fewer retries than it should. Now your restart cancels the pending retry and gets the full set of retries of its own.
