---
"@autonomos/server": patch
---

Tests can no longer touch the real ~/.autonomos: getConfigDir() now refuses to resolve the production config dir from a test process (the escape that let a bypass-mode test fixture persist into real agent state and get resurrected as a live agent by the next upgrade's boot-resume). Every persistence module now resolves the dir per-call through the guarded accessor, and all previously-unisolated suites are isolated — including two whose `??=` isolation was a silent no-op for worker-run suites (agents inherit AUTONOMOS_CONFIG_DIR pointing at the REAL dir; presence is not isolation).
