---
"@autonomos/server": patch
"@autonomos/cli": patch
"@autonomos/dashboard": patch
---

A postponed update (its signed build record couldn't be confirmed) now gets its own calm screen in the update dialog instead of the red "wasn't installed" failure. It says nothing changed and your current version keeps running, gives the reason, explains honestly when to try again (nothing retries on its own), and offers "Check again" when retrying can help. The skip override is only under Details.
