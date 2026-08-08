---
"@autonomos/server": patch
---

Fix agent status getting stuck "compacting" after a Claude Code compaction (ADR-053). The pre/post-compaction hook events were assumed to arrive in order; when they didn't, the status machine could latch on the compacting state and never recover, leaving a working agent looking wedged on the dashboard. Status resolution is now order-independent — it reconciles from whichever hook events actually arrived rather than a presumed sequence — so a compacted agent returns to its true status on its own.
