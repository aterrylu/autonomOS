---
"@autonomos/server": minor
"@autonomos/cli": minor
---

fix(security): behind `tailscale serve` (`--trust-proxy=tailscale`), autonomOS now trusts a visitor's tailnet identity only on a private socket that only you and Tailscale can open, so no other program or user on the machine can pretend to be one of your devices. Run the `tailscale serve --bg unix:<path>` command that `autonomos token status` prints. Serve still pointed at the port gets a clear error showing that command, never silent trust. See ADR-153.
