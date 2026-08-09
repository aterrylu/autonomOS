---
"@autonomos/server": minor
"@autonomos/cli": minor
---

Source-mode upgrades (ADR-077 §3): a **managed clone** — a git checkout pinned to release tags — is now a first-class install shape. `scripts/install-source.sh` creates one (the upgradeable replacement for rsync-based `make deploy`, which now warns it is a dev tool); `autonomos upgrade` on it fetches tags, refuses on a dirty tree, checks out the target tag, rebuilds (`make build`, factored out of `prod`), and health-gates the restart with automatic rollback; `autonomos rollback` returns to the recorded previous checkout. The install marker at the repo root routes resolution (bounded upward walk, source markers only).
