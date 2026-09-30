---
"@autonomos/server": patch
---

fix(security): the dashboard's API and WebSockets now refuse requests from other sites and other ports of the same host. Previously, a web page on another localhost port (for example an agent's dev server) could use your signed-in browser to create agents or read the fleet. The dashboard itself, the CLI, agents and scripts using `Authorization: Bearer` are unaffected. If you deliberately serve the dashboard from a different origin, set `CORS_ORIGIN` to it. See ADR-122.
