---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

fix(dashboard): know within a second when your typing isn't reaching the agent — per-keystroke acks, honest status bar, no late keystrokes

The bottom-left "Connected" dot was an HTTP poll that took up to ~30s to notice a stalled server or a dropped link, and it could never notice a stuck agent: with the server healthy, a frozen agent sat behind a green "Connected" and a "Ready" sidebar indefinitely while typed keys went nowhere.

- **Every keystroke is now acknowledged.** If the server doesn't confirm a key within **1s**, the pane shows **"Not reaching server… · N keystrokes waiting"**; after 3s it reconnects and says exactly how many keystrokes weren't sent. If the server has your key but the agent prints nothing, a subtle **"Waiting for agent…"** appears at 2s and **"Agent not responding · Ns"** at 5s (never while the agent is showing you a permission or choice dialog). Measured under heavy load: healthy acks and echoes come back in under 70ms, so these don't false-alarm.
- **The status bar follows a 2s heartbeat** for the times you aren't typing: **"Reconnecting… last heard Ns ago"** after 5s of silence, **"Disconnected · retrying"** after 20s.
- **Nothing you type is ever delivered late.** The server detects dead terminal connections on its own, refuses input from a connection the pane already replaced, and never writes a keystroke the pane has already reported as not sent — previously a recovered link could replay your keystrokes in a burst after you'd retyped them.
- **Fixed: `1;2c` typed into agents after a reconnect or page reload.** Replaying the terminal's history made it re-answer old terminal queries as if you'd typed them.
