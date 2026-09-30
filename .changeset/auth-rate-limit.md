---
"@autonomos/server": patch
"@autonomos/dashboard": patch
---

fix(security): repeated wrong-token attempts are now throttled. After 10 different wrong tokens from one address, sign-in attempts from it are refused for a short, growing wait (up to a minute). A browser tab still holding an old token doesn't count, and signing in with the right token resets the count. The login page says how long to wait. See ADR-124.
