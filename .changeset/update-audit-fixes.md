---
"@autonomos/cli": patch
"@autonomos/server": patch
---

fix(update): the service unit re-render no longer silently drops your login, bind address or state location. AUTONOMOS_TOKEN, AUTONOMOS_HOST and AUTONOMOS_CONFIG_DIR set in the unit are carried over. Any other variable you added is named in a warning, and the old unit is kept beside the new one. Linux units now quote every value, so a space or `%` in a path reaches the server as written. Restore refuses a snapshot that holds a symlink or device, and the update check only trusts an exact vX.Y.Z release tag.
