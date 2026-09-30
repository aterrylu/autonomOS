---
"@autonomos/server": minor
"@autonomos/cli": minor
"@autonomos/dashboard": minor
---

Updates now check each download's signed build record (the Sigstore attestation every release already publishes), not just its checksum. That proves the tarball was built by autonomOS's own release workflow at that version. A record that doesn't match means the update isn't installed and nothing changes. If the record can't be checked (GitHub or Sigstore unreachable), the update continues and says so in amber, during the update and afterwards. `AUTONOMOS_SKIP_PROVENANCE=1` skips the check on purpose (mirrors, offline machines), and autonomOS still says it wasn't checked. (ADR-126)
