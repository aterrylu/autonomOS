---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

fix(claude-usage): the Claude usage bar says why it has no numbers — a short reason on the bar (e.g. "keychain locked", "blocked (403)", "API-key auth", "no windows") with a hint in the tooltip and panel, logged once to the server log. Also reads the usage response's newer `limits[]` window list, so accounts whose 5-hour/weekly windows arrive only there (reported on a Team plan) show numbers instead of a bare "n/a". Accounts that already worked render exactly as before.
