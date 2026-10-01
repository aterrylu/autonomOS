---
"@autonomos/server": patch
---

fix(security): the server's WebSockets refuse a message split into a flood of tiny fragments, and upgrades now actually apply dependency security fixes

- The `ws` library before 8.21.1 kept every fragment of an unfinished message, with no limit, so one connection sending a stream of empty fragments could grow the server's memory until it crashed, taking every agent's terminal with it. `ws` is now 8.22.0, which closes such a connection after 16,384 fragments of one message. Normal traffic is unaffected: browsers send each message, including a large paste, as a single frame.
- Upgrading a source install (`autonomos upgrade`, the in-app update, `make build`) now reinstalls dependencies with `bun install --force`. Before, an upgrade could keep an old copy of a dependency nested under another package, so a security fix in the new version never reached the code that runs.
- If the installed dependencies are still older than this version requires, the server logs a SECURITY warning at every start and `autonomos status` shows it, with the one-line fix (`bun install --force`, then restart).
