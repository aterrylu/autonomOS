---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

fix(dashboard): honest connection status — the "Connected" dot follows a 5s heartbeat, each pane names what went silent, and keystrokes are never delivered in a late burst

The bottom-left "Connected" dot was an HTTP poll that took up to ~30s to notice a stalled server or a dropped link, and it could never notice a stuck agent: with the server healthy, a frozen agent sat behind a green "Connected" and a "Ready" sidebar indefinitely while typed keys went nowhere.

- **The dot now reads the `/ws/agents` heartbeat** (server ping every 5s, was 30s): **"Reconnecting… last heard Ns ago"** after 12s of silence, **"Disconnected · retrying"** after 30s. A stale socket is replaced immediately rather than waiting on a close that never completes on a half-open link; going offline/online or returning to the tab re-checks at once.
- **Each terminal pane shows what went silent**: **"Connection lost · reconnecting…"** when the pane's own connection is dead (it reconnects itself), or **"Agent not responding · Ns"** when the server is fine and received your keys but the agent has printed nothing. A busy agent never trips it — all three CLIs were measured to keep echoing mid-turn.
- **Typing stays live, and a drop is never silent or late**: keys the connection can't carry are counted and shown ("N keystrokes not sent"), and the server now refuses keystrokes that arrive late on a connection the pane already replaced — previously a recovered link could deliver them in a burst after you'd retyped.
- **Fixed: `1;2c` typed into agents after a reconnect or page reload.** Replaying the terminal's history made xterm re-answer old terminal queries as if you'd typed them; those replies are now dropped for 2s after each (re)connect.
