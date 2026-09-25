---
"@autonomos/server": patch
"@autonomos/core": patch
---

fix(claude-code): no false "never dismissed: trust" warning when the folder is already trusted

autonomOS marks a Claude Code agent's working folder as trusted before it starts, so the trust dialog doesn't appear. The startup watcher still waited for that dialog, so with channels off every spawn logged `[auto-trust] … timed out — never dismissed: trust` 30 s in, and the checks that confirm a starting prompt was delivered started 30 s late. When the folder is trusted, the watcher now treats the trust dialog as optional: it still answers it if it appears, doesn't wait for it, and only warns if it appeared and got stuck. A folder you declined, or one we couldn't mark, behaves exactly as before.
