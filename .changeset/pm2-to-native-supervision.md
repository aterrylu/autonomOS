---
"@autonomos/cli": minor
"@autonomos/server": minor
---

Retire pm2 from the operator path: `make prod`/`make deploy` now supervise the server with the OS-native init system (launchd on macOS, systemd-user on Linux) via `scripts/install-prod-service.sh`, not pm2. Existing pm2-managed installs are auto-migrated on the next `make prod`/`make deploy` (preserving `PORT`; set `NO_MIGRATE=1` to skip). `ecosystem.config.cjs` is removed.

New CLI: `autonomos logs` (`-f`/`--lines`) and `autonomos restart`; `autonomos stop` is now service-aware (stops via the supervisor so launchd `KeepAlive` / systemd `Restart` don't immediately revive it). The server now owns a size-rotating `~/.autonomos/logs/autonomos.log` (the supervisor's stdout goes to `/dev/null`), so logs no longer grow unbounded.
