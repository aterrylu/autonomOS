---
"@autonomos/server": patch
---

test(server): de-flake the restart-all permission-mode integration test (test-infra only)

The mixed-fleet restart-all test failed CI 3× in one day on unrelated diffs with "expected at least 2 spawn(s), saw 1" after a 45s poll. Root shape: the test ASSUMED both real claude processes survive from spawn to restart-all's snapshot; when one dies at boot (confirmed trigger at the time of writing: CC ≥2.1.26x flipped the trust-dialog default to "No, exit", so a landed auto-trust Enter exits the session), restart-all correctly skips the now-exited agent, and the test burned its poll measuring runner environment, not the product.

De-flake, keeping the teeth: the test now reads restart-all's `idMap` — the snapshot's own race-free output it previously ignored. An id missing from idMap while its record still says "running" is a LIVE agent dropped → hard fail (the bug this test exists to catch). Missing while the record says exited = the environment killed the agent pre-snapshot → the attempt is discarded and a fresh pair is spawned (bounded at 3, each retry logged to the TAP stream). Fixed sleeps replaced with settle-gated polls; every timing-sensitive assertion now appends the server-log tail so the next flake ships its own forensics.

Proven three ways against a fake-claude harness: the OLD test reproduces the CI failure byte-for-byte under a simulated boot death (RED); the new test retries through the same death and passes, logging the discarded attempt (GREEN); a product mutation making restart-all drop a live agent still fails hard with zero retries (teeth).
