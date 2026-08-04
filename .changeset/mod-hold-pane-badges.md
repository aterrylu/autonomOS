---
"@autonomos/dashboard": minor
---

Hold the primary modifier (⌘ on Mac, Ctrl elsewhere) for ~350ms and every open pane's tab shows the digit that focuses it — the tmux `display-panes` idea for the mod+digit shortcuts. Badges are computed from the same visual-order walk the shortcuts use, so the hint is the chord and cannot disagree with what pressing the number does. A quick ⌘C/⌘V never flashes them, and window blur / tab-switch clears them (a ⌘Tab away would otherwise eat the keyup and wedge the badges on).
