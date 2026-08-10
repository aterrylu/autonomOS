---
"@autonomos/dashboard": patch
"@autonomos/server": patch
"@autonomos/core": patch
---

feat(dashboard): API client layer + push-over-poll migration (API-consolidation PR A, ADR-079)

- One typed client (`request<T>()`/`ApiError`) behind family modules replaces 45+ ad-hoc raw `fetch` sites; wire shapes are declared once in `@autonomos/core` and shared by server routes and dashboard.
- Shared, visibility-gated polls (one timer per resource) replace ~12 independent intervals. Foreground cadences are unchanged byte-for-byte; hidden tabs pause pure-display polls and throttle the notification-bearing status poll (3s→15s) so desktop notifications keep flowing; returning to the tab refreshes immediately.
- The dashboard now actually subscribes to `/ws/agents`: a new `agent.status` delta (emitted on every status/unread change) plus a `statuses` map on the reconcile frame let the push bridge suspend the agents/tree/status polls while the socket is live and feed the same store paths from frames. Socket loss degrades back to polling with an immediate catch-up refresh. Steady-state background traffic drops from ~940KB/min per tab to event-driven.
- Dead store surface removed: 11 schedule/template/preset actions superseded by panels reading the shared polls and api modules.
