---
"@autonomos/dashboard": patch
---

Make the currently-displayed agent's sidebar entry far easier to spot. The active row previously used only a faint `page.border` background fill — a ~4-point luminance step on the Midnight navy that was nearly invisible. It now gets a gold/amber outline ring plus a soft glow (drawn with an inset `box-shadow`, so there is no layout shift on activation) and a subtle accent-tinted fill. The accent is sourced from each theme's own gold/amber token, so it reads correctly in Midnight (gold), Daylight (amber), and Void. The highlight works in both flat and hierarchy views — it is orthogonal to the 3px left border hierarchy view uses for parent rows, so an active agent that is also an expanded manager keeps both signals. The existing red "N unread ·" notification text is untouched and coexists with the highlight.
