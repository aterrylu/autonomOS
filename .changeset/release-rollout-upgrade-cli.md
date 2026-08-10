---
"@autonomos/server": minor
"@autonomos/cli": minor
---

`autonomos upgrade` works end-to-end (ADR-077): install shape is recorded in an `install.json` marker (never path-sniffed), upgrades verify SHA256, swap atomically, restart via the supervisor, health-gate the new version, and auto-roll back if it doesn't boot. New commands: `autonomos rollback`, `autonomos --version`, `update` alias; version pinning via `upgrade --version=X.Y.Z` and `VERSION=` on the installer. install.sh now stage-and-swaps (re-running it on a live box is a supported upgrade), the systemd unit sets `StartLimitIntervalSec=0` so a crashing update can't exhaust the restart burst, and the MCP server identity reports the real version instead of a frozen 0.3.0.
