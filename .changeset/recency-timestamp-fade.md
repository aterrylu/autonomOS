---
"@autonomos/dashboard": patch
---

Sidebar recency — timestamp-only fade. Each agent row's last-activity timestamp now signals age so wildly-stale sessions recede at a glance: a fresh (<1h) row's timestamp reads at full text brightness, 1–24h stays the normal gray, then 1–7d fades to 72% and >7d to 52% — four distinct-but-legible steps. Only the timestamp changes; the row, name, status dot, and status label stay full-strength (a 34-day "Stopped" row still reads clearly). Fresh reuses the theme's own foreground color, so it's legible on every theme with no per-theme tuning. Rides the sidebar's existing render cadence — no new timer.
