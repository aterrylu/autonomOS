---
"@autonomos/server": minor
"@autonomos/cli": minor
"@autonomos/dashboard": minor
---

feat(security): if your operator token is short, autonomOS now protects it instead of warning you about it.
- After 20 wrong sign-ins from devices that have never signed in, new devices are locked out until you unlock. Devices you've already signed in on, and the server's own machine, keep working.
- A locked-out new device sees a clear "New devices are locked out" page instead of the sign-in form. Your signed-in dashboards show an alert with **Unlock new devices** and **Details** (when, and from which address), plus an entry in the notifications bell.
- Unlock from that alert or with `autonomos auth unlock`. `autonomos token status` shows the state.
- The startup warning is now a single info line.

See ADR-148.
