---
"@autonomos/server": patch
---

fix(gateway): fail loud on inbound to a Gemini agent instead of false-acking

Gemini agents have no inbound delivery path (`messaging.inbound=false`) — their channel-server socket exists only for outbound `send()`, and its reader ignores channel notifications. `routeMessage`'s not-running guard was Codex-only, so a message routed to a Gemini agent fell through to the socket-send path and returned success ("delivered") while the message silently vanished (the ADR-064 bug class, still live for Gemini). Now a route to a Gemini target **fails loud** with a not-delivered message naming the agent + a `console.warn` — mirroring the Codex guard, but unconditional since Gemini has no receiving path in any state. A Gemini agent's **outbound** `send()` is unaffected (the guard keys on the recipient's provider). Replace with real delivery once Gemini inbound lands.
