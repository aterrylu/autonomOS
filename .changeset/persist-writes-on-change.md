---
"@autonomos/dashboard": patch
---

perf(dashboard): save dashboard state only when it changes

The dashboard rewrote all of its saved state to the browser's localStorage on
every update: every agent status change, every sidebar-resize mouse move.
That's ~80KB of JSON with a realistic Projects list, serialized on the main
thread in every open tab, including hidden ones. Now it writes only when a
saved setting actually changed. It skips serializing entirely when nothing
saved was touched, and skips the write when the result would be identical.

Measured with 3 real agents each making 6 tool calls: localStorage writes
71 → 3, bytes written 5.6MB → 243KB. Saved settings, layout and the cached
Projects list still restore on reload exactly as before.

Two side effects, both intended:
- With several tabs open, an idle tab no longer overwrites a setting you just
  changed in another tab. The most recent real change is what gets saved.
- If saving fails (browser storage full), the dashboard logs it once and keeps
  working. Before, the error interrupted whatever the dashboard was doing.
