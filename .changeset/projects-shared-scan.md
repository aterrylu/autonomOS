---
"@autonomos/server": patch
---

perf(server): open dashboard tabs share one Projects scan

Every open dashboard tab refreshes the Projects list every 30 seconds, and
each refresh re-scanned every Claude Code, Codex and Gemini conversation on
disk. With three tabs open that was three full scans. Requests that arrive
together now share one scan, and a fresh result is reused for 5 seconds. On a
real history, three tabs now use about 2.4x less CPU, and the longest pause in
the server's work is about half as long. A failed scan is never reused, so the
next refresh tries again.
