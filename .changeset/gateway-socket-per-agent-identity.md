---
"@autonomos/server": minor
"@autonomos/core": patch
---

Move inter-agent messaging off the network and make agents un-spoofable (ADR-055 PR B).

The `/ws/gateway` transport moves off the public TCP listener onto the internal Unix control socket — the same structural boundary PR A used for `/mcp` and hook ingestion, now completing it. Agents' channel servers dial `ws+unix://<socket>:/ws/gateway`, which required adding `ws` as a dependency (Node's built-in WebSocket rejects the scheme). Nothing inter-agent is reachable from the network any more.

Agents can no longer impersonate each other. Previously the gateway took a client's asserted session id verbatim and used it as the sender identity for every routed message — any process that could open the gateway could register as any agent. Now each agent gets a per-agent token, minted at spawn and verified on both the gateway `register` and hook ingestion; a missing, wrong, or unknown-session token is rejected. Hook posts are gated the same way, so one agent can no longer forge another's status or dashboard notifications. Scope, stated plainly: all agents run as the same OS user (who can read any sibling process's environment), so this is defense-in-depth and message attribution, not a hard wall against a malicious on-box process — it kills the trivial spoof and makes every message accountable.

Also in this change: the channel server's REST base (for create_agent / kill_agent / schedules, which stay on the public listener) is now an explicit `AUTONOMOS_API_URL` instead of being string-derived from the gateway URL, which no longer works once that URL is a socket; a long-standing Gemini bug that baked `localhost:3000` into agents regardless of the real port is fixed; Claude and Codex agents now get a dashboard warning if their outbound channel server fails to come up (Gemini's outbound remains a known open gap — it does not launch its channel server in interactive mode, and the warning does not yet fire for it; tracked as a follow-up); and a too-early spawn during boot now returns a retryable 503 rather than an opaque 500 no matter which startup step hasn't finished.
