---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Hosted deploys now always serve a freshly-built dashboard, and stale serves are observable instead of silent.

`make prod` removes any leftover `packages/server/src/_embedded_dashboard` (a binary-build-only artifact) before building, and `make deploy` no longer rsyncs it to the remote — so the hosted (tsx) server falls through to the freshly-built `packages/dashboard/dist` rather than a stale embedded copy shadowing it (the server prefers `_embedded_dashboard` when present). The server now logs the served dashboard's bundle id + build mtime at startup and exposes them on `/api/host`, and the dashboard logs a warning when the tab's bundle is older than what the server is serving.
