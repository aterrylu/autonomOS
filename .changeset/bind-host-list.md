---
"@autonomos/server": minor
---

feat: `--host` (and `AUTONOMOS_HOST`) take a list, e.g. `--host=127.0.0.1,100.x.y.z`, to serve this machine plus your tailnet and nothing else. If an address isn't available yet (Tailscale still connecting at boot), autonomOS keeps retrying it in the background, so restarts always work. See ADR-136.
