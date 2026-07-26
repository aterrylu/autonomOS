---
"@autonomos/server": patch
---

Stop losing Codex inbound messages in silence, and stop crying wolf on every prompted Codex agent.

Sending to a busy Codex agent looked like the message vanished: `send()` returned success and nothing else was ever logged. The message wasn't lost — inbound is idle-gated by design (injecting a turn mid-turn corrupts the thread), so it was correctly queued. But the wait emitted **nothing**: no enqueue line, a 15-minute silent poll, and an operator notification only after three consecutive failures — about 45 minutes. A working queue and a dropped message produced byte-identical logs, so a correctly-queued message got reported as a bug.

Delivery now narrates itself. You get a line when a message is queued, a line every time an attempt expires (naming whether the thread is still active or its status is unreadable, and why), and a dashboard warning once a message has waited five minutes — which is also the signal that surfaces a wedged turn. The fifteen-minute tolerance for legitimately long turns is unchanged: waiting was always correct, not *saying* you were waiting was the bug.

Four genuine silent drops are fixed alongside it. Terminating an agent with queued messages cleared them with no trace (the module's only real drop — reachable on kill, delete, PTY exit and resume-failure respawn); broadcasts skipped Codex agents with no live daemon endpoint; sending to a Codex agent whose record isn't running "succeeded" into a socket whose reader ignores inbound; and a throw inside the broadcast fan-out could take out every recipient after the sender had already been told it worked.

Separately, every Codex agent spawned with a prompt used to warn that it "may have failed to boot" and push a dashboard notification — including agents that had already run their prompt correctly. Prompt-delivery tracking reads the hook relay, and Codex emits no hook events, so the receipt could never arrive. It is now gated on the provider capability rather than running blind, which also means Codex spawn-with-prompt has no delivery detector at all; that gap is documented at the call site and in `CLAUDE.md` rather than left to be rediscovered. Claude Code and Gemini are unaffected.

Also fixes a status reconciler that could never escalate (read failures were swallowed, so its failure counter reset every cycle and a daemon that stopped answering would freeze the dashboard silently), and a leaked 30-second timer per JSON-RPC call.
