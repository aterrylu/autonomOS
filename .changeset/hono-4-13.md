---
"@autonomos/server": patch
---

fix(deps): update the web framework (hono) to 4.13.12

The server's web framework is updated from 4.12.5 to 4.13.12. This closes a slow-regex flaw in its CORS handling, where one specially crafted request could stall the server for seconds without signing in (it applies when the server is set up to accept requests from another origin), and picks up the framework's other security fixes up to 4.13.12.
