---
"@autonomos/server": patch
"@autonomos/core": patch
---

feat(analytics): one request for every agent's activity strip

A new `GET /api/agents/analytics` returns each agent's current status and its
last-24-hours activity strip in a single response, for the upcoming Org Chart
cards. It uses the same strip the detail panel shows, so the two always agree.
Long strips are simplified to at most 48 segments (a short wait for you is
always kept visible), and nothing is read from disk or git per request.
