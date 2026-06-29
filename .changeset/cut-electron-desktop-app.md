---
"@autonomos/server": minor
---

Cut the Electron desktop app (ADR-051). The canonical client is now the browser + PWA (#71) reached against an always-on server (launchd/systemd-user, ADR-050). Removes `packages/app/`, the server's `--embedded` flag + `embedded-mode.ts`, and the DMG/code-signing/notarization/electron-updater half of the release pipeline (`reusable-dmg-build.yml` gutted to a server-only `reusable-server-build.yml`; `pr-artifact.yml` removed). Retained: the pid-file mutual-exclusion lock (ADR-029 core), the launchd/systemd-user lifecycle (ADR-028 core), and the `auth.ts` CONFIG_DIR token isolation (ADR-030 server-side). No change to server runtime behavior.
