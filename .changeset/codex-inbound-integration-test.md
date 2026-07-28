---
---

Add an integration test for Codex inbound delivery: the real router, store, sidecar-endpoint lookup and delivery client are exercised end to end against a fake `codex app-server` daemon on a real loopback WebSocket. Closes the gap where every piece of that path was unit-tested but their composition — where the delivery bug in #287 actually lived — was not. Test-only; no product behavior change.
