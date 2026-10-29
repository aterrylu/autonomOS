---
"@autonomos/server": patch
"@autonomos/cli": patch
---

`tailscale serve` support (`--trust-proxy=tailscale`, added after v0.7.0 and never released) is removed. Reach autonomOS over Tailscale with `--host=127.0.0.1,<tailnet IP>`, where every device arrives from its own address. A leftover `--trust-proxy` or `AUTONOMOS_TRUST_PROXY` makes the server refuse to start with instructions; updates drop it from the service file and say so. See ADR-157.
