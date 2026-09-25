---
"@autonomos/dashboard": patch
---

perf(dashboard): sidebar rows re-render only when their own content changes, and age labels tick on their own

Each agent row's text (name, age, project · branch, preset pill, status label)
is now memoized, so a status update for one agent re-renders just that row's
text instead of every row's. With 50 agents, main-thread script time per
status update drops about 10% on a fast machine (4.27 → 3.8–3.9 ms) and about
27% under 4× CPU throttling (17.8 → 12.8–13.1 ms).

Age labels ("3m", "2d") and their recency fade used to advance only because an
unrelated 30-second projects poll happened to re-render the sidebar. They now
run on one shared 30-second clock, which pauses while the tab is hidden and
catches up as soon as you look. The age text and its fade read the same clock
value, so they always agree.

Nothing looks different. Drag-to-reorder, the recency fade in light and dark
themes, and the status labels behave exactly as before.
