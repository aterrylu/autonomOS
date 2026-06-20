---
"@autonomos/server": patch
---

Fix the Claude Usage plugin querying the wrong organization. claude.ai accounts can belong to multiple orgs; the scanner used `memberships[0]`, but the `/usage` endpoint is only authorized for the org with claude.ai access (the `chat`/`claude_max` capability). For anyone who has also used the Anthropic API, the first membership is the API/console org, which returns 403 — making a valid session key look invalid forever. `selectUsageOrg` now picks the chat/claude_max org (falling back to the sole org only when no capability signal exists), and the no-org error now distinguishes an expired key from an account with no Pro/Max subscription. Verified end-to-end against live claude.ai.
