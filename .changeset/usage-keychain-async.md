---
"@autonomos/server": patch
---

perf(usage): stop the Claude usage poll from freezing the server

Each Claude usage read ran a synchronous `security` keychain lookup before
checking its cache. Spawning that subprocess synchronously from the server
blocked the whole event loop for 50–130ms per poll: every terminal stream,
keystroke echo and hook waited, several times a minute per open dashboard tab.

The token read is now asynchronous and memoized: one read per 60s, shared by
concurrent polls. A missing, expired or rejected (401) token is re-read every
10s until it works, so a rotated or fixed login shows up quickly. A keychain
read that never returns is cut off after 2s. It is still read-only: autonomOS
never refreshes Claude Code's token. Measured on an isolated instance: the
server's on-thread time per usage read dropped from 87.6ms (all of it in the
synchronous spawn) to 0.26ms, with identical usage numbers.

When no token is found, the reader now records why
(`getLastCredentialFailure()`: the `security` exit code and stderr, a timeout,
or a missing or malformed credentials file) so the usage panel can explain an
"n/a" instead of showing it bare.
