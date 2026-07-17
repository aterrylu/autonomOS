---
"@autonomos/server": patch
"@autonomos/cli": patch
---

**Security:** require auth on `/mcp`, and bind loopback by default.

Two issues that composed into unauthenticated remote code execution. The auth middleware was mounted on `/api/*` and `/ws/*` only, so `/mcp` — the Streamable-HTTP transport exposing `create_agent`, `kill_agent`, and `set_manager` — matched neither prefix and had no check of its own. Separately, `serve()` was called without a `hostname`, so Node bound `0.0.0.0`/`::` and the port was reachable from any network the machine was attached to. Together, anyone on the same network (coffee shop, office, dorm) could open an MCP session with a single `curl` and spawn an agent with `permissionMode: "bypass"`, an arbitrary `workingDirectory`, and an arbitrary prompt — arbitrary code execution as the user running the server, no credential required.

Both are closed. `/mcp` now requires the same token as every other route, checked at the transport boundary so an unauthenticated caller cannot complete `initialize` and never obtains the session id later calls depend on. The server now binds `127.0.0.1` unless told otherwise.

**This is a breaking change if you reach your dashboard over the network.** A new `--host` flag (env `AUTONOMOS_HOST`) opts back in, and it threads through the service installer so a supervised daemon keeps its bind across reinstalls:

```
BIND_HOST=0.0.0.0 make deploy     # or set BIND_HOST=0.0.0.0 in the remote's .env
```

The recommended form for a box that should always be exposed is `AUTONOMOS_HOST=0.0.0.0` in that machine's `.env` — the service wrapper runs `tsx --env-file=<repo>/.env`, so it survives reinstalls. `BIND_HOST` bakes `--host` into the service file, which a later `install-service --force` without it would drop.

An exposed bind now logs a startup warning naming the interface. No new token infrastructure is involved: the server already generates and persists a random 256-bit token on first start, and `install-service` prints it.

**Still unauthenticated, on every bind:** `POST /api/hooks/*` (the agent hook relay) and `GET /api/host`. Neither can spawn or control agents, but an unauthenticated caller can forge agent status and inject dashboard notifications. Closing those changes how the token reaches spawned agents and risks a fleet-wide status blackout if it doesn't, so it gets its own change rather than riding along with an urgent patch. The startup warning names this gap rather than claiming blanket coverage.
