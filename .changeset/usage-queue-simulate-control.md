---
"@autonomos/server": patch
---

Add a dev/QA usage-limit simulation control so the queue-send-on-clear feature can be demoed without actually hitting a real limit. `POST /api/usage-queue/_simulate?state=capped|cleared|off` overrides what `getRateLimits` returns — so the dashboard usage panel AND the queue watcher both see the simulated value — and kicks an immediate evaluation instead of waiting for the 60s poll. Gated behind the `AUTONOMOS_ENABLE_USAGE_SIMULATION` env flag; the endpoint 404s in normal/prod runs.
