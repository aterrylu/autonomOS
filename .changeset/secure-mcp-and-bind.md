---
"@autonomos/server": patch
"@autonomos/cli": patch
---

**Security:** require auth on `/mcp` (closes an unauthenticated RCE).

The auth middleware was mounted on `/api/*` and `/ws/*` only, so `/mcp` — the Streamable-HTTP transport exposing `create_agent`, `kill_agent`, and `set_manager` — matched neither prefix and had no check of its own. Because the server also listens on all network interfaces, anyone able to reach the port could open an MCP session with a single `curl` and spawn an agent with `permissionMode: "bypass"`, an arbitrary `workingDirectory`, and an arbitrary prompt — arbitrary code execution as the user running the server, no credential required.

`/mcp` now requires the same token as every other route, checked at the transport boundary so an unauthenticated caller cannot complete `initialize` and never obtains the session id that later calls depend on. Your browser control path (`POST /api/agents`) already required the token; this locks the parallel door that didn't.

**Not a breaking change.** The bind is unchanged — the server still listens on all interfaces by default, so dashboards reached over Tailscale, GCP IAP, or SSH keep working exactly as before. A new `--host` flag (env `AUTONOMOS_HOST`) is an opt-in to *restrict* the bind — e.g. `--host=127.0.0.1` for a box you only reach through an SSH tunnel. It threads through `install-service` so a supervised daemon keeps the setting across reinstalls.

**Still unauthenticated, on every bind:** `POST /api/hooks/*` (the agent hook relay) and `GET /api/host`. Neither can spawn or control agents, but an unauthenticated caller on the network can forge agent status and inject dashboard notifications. A follow-up change will move the internal control plane (`/mcp`, `/ws/gateway`, `/api/hooks`) onto a loopback-only listener so it isn't network-reachable at all; the startup line names this residual until then.

No new token infrastructure: the server already generates and persists a random 256-bit token on first start, and `install-service` prints it.
