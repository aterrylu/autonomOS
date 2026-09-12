---
"@autonomos/dashboard": patch
---

fix: restarting a focused agent no longer leaves its terminal blank

Restarting an agent **while its pane was already focused** left the terminal "just gone" until you clicked the agent again; restarting from another pane worked. The kill closes the terminal socket (4010) → the keep-alive terminal is marked `ended` and stays showing final output, and the pane only reconnects when it remounts — but `switchPane(sameId)` is a no-op when you're already on that pane, and whether `activePane` gets retargeted away first is a race the fast path loses (ADR-097).

Fix: a per-session `terminalReloadNonce` that `restartSession` bumps after a successful attach; `useTerminal`'s attach effect depends on it, so the pane deterministically drops the dead terminal and re-acquires a fresh one bound to the restarted PTY — regardless of the `activePane` race. Guarded (`disposeTerminal` on a bump-while-mounted only) so an ordinary switch-back still reuses the cache (ADR-072 keep-alive, re-streams nothing). Rename (ADR-096) restarts too, so it inherits the reconnect.

Tests: store (`reloadTerminal` bumps per-id; `restartSession` bumps on attach-success, not on attach-failure) and a `useTerminal` dom test (nonce bump re-acquires; fresh mount / other-session bump does not dispose — keep-alive intact), mutation-verified.
