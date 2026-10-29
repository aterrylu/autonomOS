---
"@autonomos/server": patch
---

Fix a server freeze on large session histories: when live Codex usage was unavailable, the on-disk fallback read the newest Codex rollouts whole (hundreds of MB each) about once a minute and blocked the server for seconds. It now reads only each file's tail, asynchronously, and backs off its directory scan while live usage keeps failing; the panel names the live failure ("Live Codex usage is failing (HTTP 503)"). The Projects title lookup also no longer re-reads a growing session from the start on every poll.
