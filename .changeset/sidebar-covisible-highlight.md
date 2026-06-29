---
"@autonomos/dashboard": patch
---

Distinct sidebar highlight for co-visible (grouped-but-not-focused) agents. When several panes share a dockview group, the focused one already gets the gold active ring; the *other* on-screen members previously got only a near-invisible fill. They now get a neutral (theme-foreground) outline ring + faint fill — the same ring affordance as the active highlight but a quieter, different color — so grouped panes clearly read as "also here, just not focused." The glow stays reserved as the focus signal.
