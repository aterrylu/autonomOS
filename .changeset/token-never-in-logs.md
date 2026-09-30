---
"@autonomos/server": patch
---

fix(security): the server no longer prints the operator token in its startup banner. Short tokens used to appear in full; now only a long token's last 4 characters are shown. The log file is created readable by you only, and each start removes other users' access from files an older version left readable (the config folder, logs, schedule history, presets). Your token and logins keep working. See ADR-123.
