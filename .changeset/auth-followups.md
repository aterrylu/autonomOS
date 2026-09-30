---
"@autonomos/server": patch
"@autonomos/cli": patch
---

fix: the startup permission tightening now also leaves alone the real parent folders of a home directory that is reached through a symlink (for example `/home` → `/data/home`). `autonomos --help` no longer claims the server listens on this machine only by default: it listens on all network interfaces unless you pass `--host=127.0.0.1`.
