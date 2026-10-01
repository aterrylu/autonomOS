---
"@autonomos/server": minor
"@autonomos/cli": minor
---

feat: `--trust-proxy=tailscale` (or `AUTONOMOS_TRUST_PROXY=tailscale`) makes `tailscale serve` the recommended way to reach autonomOS from other devices: HTTPS, no open port, and each device is still told apart, so the sign-in throttle and the new-device lock work per device and a lockout names the device's Tailscale user. It requires `--host=127.0.0.1` (autonomOS refuses to start otherwise). `install-service` accepts it and updates keep it; `autonomos token status` says when it's on. See ADR-137.
