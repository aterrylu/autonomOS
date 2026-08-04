---
"@autonomos/dashboard": minor
---

mod+1–9 now switches to the Nth AGENT in the sidebar (rendered order — pinned first in flat view; depth-first with collapsed subtrees skipped in hierarchy view), replacing the open-pane-position semantics: digits are agent navigation, like clicking the row. Hold the modifier ~350ms and each agent row shows the digit that switches to it; badges and shortcuts read the same published row order, so the hint cannot lie. Quick chords never flash badges; window blur/tab-switch clears them. See ADR-066.
