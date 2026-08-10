---
"@autonomos/cli": minor
---

`autonomos upgrade` now keeps the supervisor unit in sync with the current template (ADR-080), and the service identity (launchd label / systemd unit name) is overridable via `AUTONOMOS_SERVICE_LABEL` so test harnesses can never address the production daemon (ADR-081; the unit-sync heal preserves whatever label the installed unit carries). On every upgrade — including "already up to date" — the installed launchd plist / systemd user unit is parsed, re-rendered around its own install-time parameters (program path, `--port`/`--host`, baked `HOME`/`PATH`), and byte-compared: identical means nothing is written and no supervisor command runs; genuine template drift is healed and applied by the upgrade's one existing restart (bootout+bootstrap on macOS so launchd re-reads the plist; daemon-reload on Linux). Unparseable units are left untouched with manual instructions, and a sync failure never blocks the upgrade. Rollback remains unit-untouched.
