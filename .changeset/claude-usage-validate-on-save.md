---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

Fix the Claude Usage reconfigure loop: the setup panel now validates the session key against claude.ai before reporting success (no more false "Saved!" for a key that doesn't work), and failures are categorized (`errorKind`) so credential errors offer "Reconfigure" while transient ones (rate limit, outage) offer "Retry" and say it's not a key problem. The usage cache is fingerprinted by session key so a key change is never served the previous key's data.
