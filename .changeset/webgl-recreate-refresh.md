---
"@autonomos/dashboard": patch
---

HARDENING (not a fix — the fullscreen-blackout bug remains open and under investigation): every WebGL renderer (re)creation now forces a full-viewport re-rasterization from the intact buffer, so stale or blank rows left behind by a dying GPU context repaint on pane attach and on context-loss rebuild. Client-side only: zero bytes to the PTY, no re-stream — millisecond-scale work on rare events.
