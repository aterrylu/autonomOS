---
"@autonomos/server": minor
"@autonomos/cli": minor
"@autonomos/dashboard": minor
---

Updates now check each download's signed build record (the Sigstore attestation every release already publishes), not just its checksum. That proves the tarball was built by autonomOS's own release workflow at that version, from a commit on main, and the bundle must be the version its tag names. A record that doesn't match means the update isn't installed and nothing changes. If the record can't be checked (GitHub or Sigstore unreachable, or rate-limited), the update is postponed: nothing changes, and it can be tried again later. `AUTONOMOS_SKIP_PROVENANCE=1` skips the check on purpose (mirrors, offline machines): the update installs, and autonomOS says in amber that it wasn't checked. (ADR-126)
