---
---

The install and gate step that makes node-pty's macOS spawn-helper executable now fixes the copy the server actually loads. A stale node-pty@1.0.0 left in bun's store sorted first and got "fixed" instead, leaving 1.1.0's helper at 644, so every PTY spawn failed with "posix_spawnp failed." It now also runs as the first step of `make check`, so an affected worktree heals itself.
