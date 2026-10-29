---
"@autonomos/dashboard": patch
---

fix(orgchart): with two top-level teams, both stay in view as agents come and go

The Org Chart could show only one of two top-level teams, and after you removed the team on screen it looked empty even though the other team was still running. The chart was there but stranded off-screen. The view now re-frames to the current fleet when you haven't moved it, or when it would otherwise show no agent; a view you've panned or zoomed stays where you put it.
