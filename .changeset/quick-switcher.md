---
"@autonomos/dashboard": minor
---

⌘K (Ctrl+K elsewhere) opens an agent quick-switcher: type a few letters of a name, Enter to switch — fuzzy-ranked (prefix > word-boundary > substring > subsequence, ties follow sidebar order), listing every live agent including ones hidden inside collapsed hierarchy groups. Terminal-clear moves from ⌘K to ⌘⇧K: the palette idiom takes the unshifted chord, and `clear`/Ctrl+L still work. See ADR-071.
