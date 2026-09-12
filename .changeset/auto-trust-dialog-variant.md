---
"@autonomos/server": patch
"@autonomos/core": patch
---

fix(auto-trust): survive CC ≥2.1.26x's default-No trust dialog — pre-trust the workdir at spawn, and never confirm a dialog blind

Claude Code ≥2.1.26x replaced its trust prompt with a "Quick safety check" dialog whose DEFAULT selection is "❯ No, exit". autonomOS auto-trust wrote a bare Enter, with two failure modes (both live-probed on 2.1.267/2.1.269): when the Enter LANDED, the session exited — random fleet-agent deaths at boot, the mechanism behind the restart-all CI flake; when it was SWALLOWED by CC's stdin-attach race, the dialog persisted but the watcher false-settled (any needle-free byte in its 500ms window counted as "dismissed"), leaving the agent alive-but-stuck on the dialog — Terry's local usage-queue failure. Net effect on current CC: every spawn into an untrusted directory died or hung.

The fix has a prevention half and a dismissal half:

- **Prevention (primary): spawn-side pre-trust.** A new optional provider hook `prepareSpawn` runs before the PTY exists (gated on the same autoTrust setting as the watcher); claude-code implements it by writing `projects[<realpath cwd>].hasTrustDialogAccepted: true` into `~/.claude.json` — byte-identical to what CC records when a user picks Yes — so the dialog never renders. Best-effort by contract (missing/malformed config = skip; atomic tmp+rename write; existing decisions, declines included, are never overwritten). Keystroke dismissal is inherently racy: an Ink re-mount (e.g. the resize nudge a terminal attach fires) resets the selection to the default BETWEEN our keys — observed killing an agent 0.7s after spawn. A config write has no such window.

- **Dismissal (fallback, hardened):** the watcher now reads WHERE the ❯ highlight sits before confirming anything: default-No → Down, then an Enter GATED on fresh evidence that the latest highlight is Yes (a selection reset blocks the confirm and triggers a re-reading retry); legacy no-marker dialog keeps the bare Enter; engagement itself defers until a ❯ paints so a needle-before-highlight frame can't provoke a blind Enter. Dismissal verification can no longer false-settle: the ANSI stripper now consumes private-parameter CSI (`ESC[>0q` chatter no longer leaks "0q" fragments as fake evidence), fresh output below an evidence floor re-arms a retry instead of settling, and even a transition-sized repaint is only believed after a confirmation window in which the needle stays absent.

Verification: 12 new unit tests (RED-first against the pre-fix watcher — default-No keys, self-correcting retry, false-settle, chatter-as-silence, confirmation window, remount race, paint-order deferral, and the pre-trust write's shape/idempotence/skip paths). End-to-end on this machine: a spawn into a fresh untrusted directory previously died 0.7s after spawn or hung on the dialog; with the fix the workdir is pre-trusted, no dialog renders, and the previously always-failing `usage-queue auto-fire — real spawn` integration test passes with zero auto-trust engagements.
