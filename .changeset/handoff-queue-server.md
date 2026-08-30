---
"@autonomos/core": minor
"@autonomos/server": minor
---

feat(handoff): hand-off queue — human-mediated inbound for inbound-less agents

A message sent to an agent whose runtime has no live inbound path (Gemini's
interactive CLI — `messaging.inboundMethod: "manual-queue"`) is now QUEUED for
human hand-delivery instead of failing. The sender is told SUCCESS with an honest
note ("accepted — queued for hand-delivery", per ADR-064 — accepted, not
delivered), fire-and-forget. Queues are disk-persisted per agent in `$configDir`
(survives restart), capped at 10 (a send past the cap is a real failure), and
cleared when the agent is deleted.

Delivery is a PTY injection (bracketed-paste + Enter) triggered via REST
(`GET/POST/DELETE /api/agents/:id/queue…`); an item leaves the queue only when a
`UserPromptSubmit` hook confirms it was submitted (the receipt), so an
unconfirmed paste keeps the message queued. One injection is in flight per agent;
send-all drains one at a time, each gated on its receipt. The delivery trigger is
kept separable from the queue+injection mechanics (a human click today; an
auto-send mode or user-input textbox later use the same path). The dashboard UI
(pending-count badge + delivery pane) ships separately. See ADR-094.
