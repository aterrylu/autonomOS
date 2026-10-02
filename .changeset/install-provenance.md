---
"@autonomos/server": patch
---

New installs check the release's signed build record: `install.sh` verifies the downloaded tarball's Sigstore provenance before installing, and refuses when it's invalid or can't be checked (`AUTONOMOS_SKIP_PROVENANCE=1` skips, loudly). The latest version is pinned from GitHub before downloading, so the tarball and its checksums always come from the same release.
