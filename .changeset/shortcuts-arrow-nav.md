---
"@autonomos/dashboard": minor
---

mod+↑ / mod+↓ walk the sidebar agent list relative to the active agent (clamped at the ends; with no active agent, ↓ enters at the top and ↑ at the bottom) — the complement to mod+1–9 for fleets past nine agents. While holding the modifier, the rows directly above/below the active agent show ↑/↓ chips alongside the digit badges, from the same published row order the shortcuts execute against. Non-Mac cost recorded: Ctrl+↑/↓ carries an xterm encoding (CSI 1;5A/B) that is now app-reserved, documented in the NON_MAC_COST table.
