---
"@autonomos/server": patch
---

The release build now checks the bundle it produced: on macOS it fails unless node-pty's `spawn-helper` is staged executable and its path points into the bundle, since a bundle without that can't start any agent ("posix_spawnp failed"). Every PR's install test also spawns an agent from the installed bundle and requires it to still be running a few seconds later.
