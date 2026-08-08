---
"@autonomos/server": patch
---

Rewrite the `MCP_INSTRUCTIONS` block that every autonomOS-spawned session receives, clarifying the inter-agent messaging model and adding a peer-discovery note so agents understand how to find and address each other. A drift-guard test now pins the instructions against the actual registered tool set, so the guidance agents are given can't silently fall out of sync with the tools that exist.
