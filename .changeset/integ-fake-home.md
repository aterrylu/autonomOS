---
"@autonomos/server": patch
---

Test isolation: the real-agent integration suites now run under a throwaway home directory and fail if anything lands in your real `~/.claude`. Before, each run left sessions in the Projects panel and trust entries in `~/.claude.json`. The usage plugin also gains an `AUTONOMOS_DISABLE_CREDENTIAL_READS=1` opt-out that the suites use.
