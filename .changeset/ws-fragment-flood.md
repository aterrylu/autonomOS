---
"@autonomos/server": patch
---

fix(security): the server's WebSockets refuse a message split into a flood of tiny fragments, and upgrades now actually apply dependency security fixes

- The `ws` library before 8.21.1 kept every fragment of an unfinished message, with no limit, so one connection sending a stream of empty fragments could grow the server's memory until it crashed, taking every agent's terminal with it. `ws` is now 8.22.0, which closes such a connection after 16,384 fragments of one message. Normal traffic is unaffected: browsers send each message, including a large paste, as a single frame.
- Upgrading a source install (`autonomos upgrade`, the in-app update, `make build`) now checks that the dependencies the server actually loads meet this version's security minimums. If they don't, it reinstalls them exactly as the lockfile says (`bun install --force --frozen-lockfile`) and fails the build if that doesn't fix it. Before, an upgrade could keep an old copy of a dependency nested under another package, so a security fix in the new version never reached the code that runs. A healthy install still builds offline.
- If the installed dependencies still don't meet those minimums, the server logs a SECURITY warning at every start, and `autonomos status` shows a "security floors" line (ok, NOT MET with the one-line fix, or n/a for a bundle install).
