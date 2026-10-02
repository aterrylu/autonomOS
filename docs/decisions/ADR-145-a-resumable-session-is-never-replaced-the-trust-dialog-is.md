## ADR-145: A resumable session is never replaced; the trust dialog is answered only once settled

- **Date:** 2026-10-02
- **Decided by:** an agent (Onboarding, owner of the startup watcher and the resume safety net), on TeamLead's brief relaying Terry's report
- **Supersedes:** part of ADR-049 (the "respawn fresh after a fast resume failure" net, narrowed by ADR-100)
- **Context:** On restarts and deploys, agents whose working directory is the home folder died on start, and resumed agents that died fast lost their conversation. Measured on real Claude Code 2.1.287:
  - Claude Code records `hasTrustDialogAccepted: false` for `$HOME` even after the trust dialog is accepted, so such an agent sees the default-No dialog on every start. Our pre-trust (ADR for #374) keeps an existing `false`.
  - A key arriving in the first ~150 ms after the dialog paints is applied (CC draws `❯ Yes`) and then CC resets its selection to "No, exit", internally before redrawing. The watcher's "verify ❯ Yes, then Enter" was time-of-check/time-of-use, so its Enter confirmed "No, exit" and the agent exited 1. 7 of 12 real starts died.
  - ADR-049's net then regenerated `providerSessionId` for any pre-flight-gated resume that exited non-zero within 5 s and started it fresh. The session on disk was fine; the start-up had failed.
- **Decision:**
  1. The watcher engages the trust dialog only after the PTY has been quiet for 750 ms after it rendered (capped at 4 s), and confirms with Enter only after `❯ Yes` has stayed the newest selection for 300 ms. A reset retries; it never confirms.
  2. A session the resume pre-flight proved exists is never replaced. A fast, failing resume retries the same session (twice, with backoff), then the agent is left stopped (`crashed`) with its `providerSessionId` intact and a notice that the session is intact. A death while a startup dialog was still on screen is recorded as a dialog failure.
  3. Only a session that is truly missing starts fresh, as before, decided by the pre-flight before spawning (ADR-111).
- **Rationale:** A fast exit is far more often the start-up than the session, and a fresh start silently loses the conversation while an intact transcript sits unused on disk. Stopping with a notice costs one manual restart in the rare real-corruption case; regenerating cost conversations in the common case. For the dialog, a fixed delay would be tuned to one machine's speed, while quiet-then-hold follows the dialog's actual state and held under CPU load (0/12 deaths at load ~8, 0/20 idle).
- **Alternatives considered:**
  - Write `hasTrustDialogAccepted: true` for the home folder so the dialog never shows. Rejected for now: Claude Code deliberately does not persist trust for `$HOME`, so overriding it is a security-policy call for Terry, not a bug fix.
  - A fixed delay before the first key. Rejected: the unsafe window grows with machine load.
  - Keep regenerating, but only after N retries. Rejected: it still ends by discarding a good conversation.
  - Quiet-gate the retry after a reset as well. Dropped: no modeled timing could distinguish it from the plain retry, so it would be untested code.
- **Source:** PR #502; TeamLead brief 2026-10-02 (agent channel); measurements on real Claude Code 2.1.287 in that PR's Validation section.
