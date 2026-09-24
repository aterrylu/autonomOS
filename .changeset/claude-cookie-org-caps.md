---
"@autonomos/server": patch
---

fix(claude-usage): a pasted full claude.ai cookie (one that already names its org) now gets the same Pro/Max check as every other path, so a Max account never shows a spend meter by mistake. If the org's plan can't be looked up, spend stays off and the reason is logged once.
