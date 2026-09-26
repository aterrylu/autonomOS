---
"@autonomos/server": patch
---

feat(server): opt-in log of every keystroke autonomOS sends into agent terminals

For diagnosing "something typed into my session" reports. `touch ~/.autonomos/pty-input-log.on` then `autonomos restart` records the next start only, or set `AUTONOMOS_PTY_INPUT_LOG=1` when running the server yourself. Each write is logged with the agent and the sender (the dashboard, auto-trust, prompt re-delivery, the usage queue or a handoff) to `logs/pty-input.log`, readable only by you and rotated. Control keys and escape codes are written out; typed text appears only as its length. Recording stops by itself 30 minutes after the start, and the server log says when it turns on and off. Off by default: nothing changes unless you turn it on.

The switches are never passed on to agents, so an autonomOS an agent starts itself does not come up recording.
