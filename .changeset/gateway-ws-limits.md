---
"@autonomos/server": patch
---

fix(gateway): bound agent messages and the warnings bad ones cause

- A single message between agents is now limited to 1 MiB (it was effectively 100 MiB, which let one agent make the server hold that much in memory per message). An agent that tries to send more gets a clear error right away, suggesting it write the content to a file and send the path.
- A client that keeps sending malformed messages now produces a few warnings and then a count, instead of one log line per message.
- Values that come from an agent are quoted in the server log, so they can't break a log line apart or impersonate another one.
