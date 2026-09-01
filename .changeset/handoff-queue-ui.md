---
"@autonomos/dashboard": minor
"@autonomos/server": minor
---

feat(handoff): hand-off queue dashboard — pending badge + minimal delivery overlay

The dashboard half of the Hand-Off Queue (ADR-094; server in #355). An agent with
messages queued for human hand-delivery (a manual-queue provider — Gemini) now
shows a gold pending-count pill on its sidebar row, independent of the status
dot/label. A minimal, free-floating **delivery overlay** appears in that agent's
terminal pane — reusing the `useDraggableOverlay` hook (grip drag + keyboard
nudge, per-terminal persisted position, clamp), stacked beneath the usage-queue
overlay by default. It auto-hides until the queue is non-empty, lists the queued
messages, and offers per-row Send / one-click Discard plus footer Send-all (no
confirm) and Discard-all (inline confirm); a row shows "delivering…" while a send
awaits its hook receipt. A `DELETE /api/agents/:id/queue` clear-all endpoint backs
Discard-all.
