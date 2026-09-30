---
"@autonomos/server": patch
---

fix: a dashboard served from the origin named in `CORS_ORIGIN` is no longer refused by current browsers. Every other site stays refused. See ADR-125.
