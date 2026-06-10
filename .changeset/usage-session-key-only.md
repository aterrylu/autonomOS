---
"@autonomos/server": minor
"@autonomos/dashboard": minor
---

Cloud Usage: the session key is now the only required credential. The
organization UUID is resolved automatically from the session key via
claude.ai's bootstrap API, so the Org ID field is gone from the setup and
credentials panels. Existing configs that still carry an org ID keep working
— it's accepted-but-discarded by the settings API and ignored at read time.
