---
"@autonomos/server": minor
---

`send()` now reports whether a message was actually DELIVERED, not merely routed. Previously the ack was given the moment the router found a plausible recipient, so an agent was told "sent" for a message injected into a dead Codex daemon, an agent whose thread never appeared, or a socket that was mid-close — a false success that has cost real debugging time. Delivery to Codex is now confirmed by the daemon's `turn/start` reply, and delivery to Claude Code requires an OPEN registered socket rather than a `send()` that merely didn't throw. A message that has not landed yet is reported as not delivered, with a note that it is retried automatically and must not be re-sent.

`broadcast://all` and `slack://` are removed. Broadcast acked success unconditionally and let any agent inject a turn into every running Codex agent; `slack://` was backed by a stub adapter whose `send()` was a `console.log` returning a fabricated message id, so it reported success for every message by construction. Agents still holding `broadcast://all` in their system prompt get an error naming `agent://` as the replacement. See ADR-064.
