---
"@autonomos/server": minor
"@autonomos/cli": minor
"@autonomos/dashboard": minor
---

feat(security): if your operator token is short, autonomOS now protects it instead of warning you about it.
- After 20 wrong sign-ins from devices that have never signed in, new devices are locked out until you unlock. Devices you've already signed in on, and the server's own machine, keep working.
- Unlock with `autonomos auth unlock` or the "New devices locked · Unlock" button in the dashboard. `autonomos token status` shows the state.
- The startup warning is now a single info line.

See ADR-135.
